import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Route test
app.get("/", (req, res) => {
  res.json({ ok: true, name: "Marto API" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Marto API running on port ${port}`));

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
    console.error(e);
    res.status(500).json({ error: "Erreur lors de la création du produit" });
  }
});

app.get("/products", async (req, res) => {
  try {
    const { rows } = await pool.query("select * from products order by created_at desc");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur lors de la récupération des produits" });
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
    console.error(e);
    res.status(500).json({ error: "Erreur lors de la création de la commande" });
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

    // Mettre à jour la commande
    await pool.query("update orders set status='assigned' where id=$1", [order_id]);

    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur lors de l'assignation de la livraison" });
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

    // Mettre à jour la commande associée
    await pool.query("update orders set status='delivered' where id=$1", [rows[0].order_id]);

    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur lors de la livraison" });
  }
});
