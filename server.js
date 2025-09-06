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
