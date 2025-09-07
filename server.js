import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Connexion à la base Postgres (Supabase)
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🔎 Debug : afficher l’URL (attention, ça montre aussi le mot de passe en clair, à retirer en prod)
console.log("🔌 DATABASE_URL utilisé :", process.env.DATABASE_URL);

// Middleware d’authentification
function auth() {
  return (req, res, next) => {
    const header = req.headers["authorization"];
    if (!header) return res.status(401).json({ error: "Token manquant" });

    const token = header.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Token invalide" });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
      if (err) return res.status(403).json({ error: "Token invalide" });
      req.user = user;
      next();
    });
  };
}

// ==========================
// ROUTE TEST
// ==========================
app.get("/", (req, res) => {
  res.json({ ok: true, name: "Marto API" });
});

// ==========================
// AUTHENTIFICATION
// ==========================
app.post("/auth/register", async (req, res) => {
  const { full_name, email, phone, password, role } = req.body;
  if (!email || !password || !role) {
    return res.status(400).json({ error: "Champs manquants" });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `insert into users(full_name, email, phone, password_hash, role)
       values($1,$2,$3,$4,$5) returning id, full_name, email, role`,
      [full_name, email, phone, hashed, role]
    );
    const user = rows[0];
    const token = jwt.sign(user, process.env.JWT_SECRET);
    res.json({ token, user });
  } catch (e) {
    console.error("❌ Erreur SQL register:", e);
    res.status(500).json({ error: "Erreur lors de l'inscription", details: e.message });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query("select * from users where email=$1", [email]);
    if (!rows.length) return res.status(400).json({ error: "Utilisateur introuvable" });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: "Mot de passe incorrect" });

    const payload = { id: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET);
    res.json({ token, user: payload });
  } catch (e) {
    console.error("❌ Erreur SQL login:", e);
    res.status(500).json({ error: "Erreur lors de la connexion", details: e.message });
  }
});

app.get("/me", auth(), (req, res) => {
  res.json({ user: req.user });
});

// ==========================
// PRODUITS (par commerçants)
// ==========================
app.post("/products", auth(), async (req, res) => {
  if (req.user.role !== "commercant") {
    return res.status(403).json({ error: "Seuls les commerçants peuvent créer des produits" });
  }
  try {
    const { name, description, price, stock, image_url } = req.body;
    const { rows } = await pool.query(
      `insert into products(merchant_id, name, description, price, stock, image_url)
       values($1,$2,$3,$4,$5,$6) returning *`,
      [req.user.id, name, description, price, stock || 0, image_url || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("❌ Erreur SQL produits:", e);
    res.status(500).json({ error: "Erreur lors de la création du produit", details: e.message });
  }
});

app.get("/products", async (req, res) => {
  try {
    const { rows } = await pool.query("select * from products order by created_at desc");
    res.json(rows);
  } catch (e) {
    console.error("❌ Erreur SQL get products:", e);
    res.status(500).json({ error: "Erreur lors de la récupération des produits", details: e.message });
  }
});

// ==========================
// COMMANDES (par clients)
// ==========================
app.post("/orders", auth(), async (req, res) => {
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "Seuls les clients peuvent créer des commandes" });
  }
  try {
    const { merchant_id, items } = req.body; // items = [{ product_id, quantity }]
    if (!items || !items.length) {
      return res.status(400).json({ error: "La commande doit contenir au moins un produit" });
    }

    // Calcul du total
    let total = 0;
    for (const item of items) {
      const { rows } = await pool.query("select price from products where id=$1", [item.product_id]);
      if (!rows.length) return res.status(404).json({ error: `Produit ${item.product_id} introuvable` });
      total += rows[0].price * item.quantity;
    }

    // Créer la commande
    const { rows: orderRows } = await pool.query(
      `insert into orders(client_id, merchant_id, total_amount)
       values($1,$2,$3) returning *`,
      [req.user.id, merchant_id, total]
    );
    const order = orderRows[0];

    // Ajouter les items
    for (const item of items) {
      const { rows: prodRows } = await pool.query("select price from products where id=$1", [item.product_id]);
      await pool.query(
        `insert into order_items(order_id, product_id, quantity, price)
         values($1,$2,$3,$4)`,
        [order.id, item.product_id, item.quantity, prodRows[0].price]
      );
    }

    res.status(201).json(order);
  } catch (e) {
    console.error("❌ Erreur SQL commande:", e);
    res.status(500).json({ error: "Erreur lors de la création de la commande", details: e.message });
  }
});

// ==========================
// LIVRAISONS (par livreurs)
// ==========================
app.post("/deliveries/:order_id/assign", auth(), async (req, res) => {
  if (req.user.role !== "livreur") {
    return res.status(403).json({ error: "Seuls les livreurs peuvent accepter une livraison" });
  }
  try {
    const { order_id } = req.params;

    const { rows } = await pool.query(
      `insert into deliveries(order_id, deliverer_id, status, assigned_at)
       values($1,$2,'assigned', now())
       on conflict (order_id) do update set deliverer_id=$2, status='assigned', assigned_at=now()
       returning *`,
      [order_id, req.user.id]
    );

    await pool.query("update orders set status='assigned' where id=$1", [order_id]);

    res.json(rows[0]);
  } catch (e) {
    console.error("❌ Erreur SQL assign livraison:", e);
    res.status(500).json({ error: "Erreur lors de l'assignation de la livraison", details: e.message });
  }
});

app.post("/deliveries/:id/complete", auth(), async (req, res) => {
  if (req.user.role !== "livreur") {
    return res.status(403).json({ error: "Seuls les livreurs peuvent livrer" });
  }
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `update deliveries set status='delivered', delivered_at=now()
       where id=$1 and deliverer_id=$2 returning *`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Livraison introuvable" });

    await pool.query("update orders set status='delivered' where id=$1", [rows[0].order_id]);

    res.json(rows[0]);
  } catch (e) {
    console.error("❌ Erreur SQL complete livraison:", e);
    res.status(500).json({ error: "Erreur lors de la livraison", details: e.message });
  }
});

// Lancement du serveur
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Marto API running on port ${port}`));
