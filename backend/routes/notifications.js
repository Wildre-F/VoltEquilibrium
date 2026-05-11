const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateToken } = require("../helpers/auth");

// ── Helper ───────────────────────────────────────────────────────────────────

async function createNotification(userId, type, title, message, metadata = {}) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, message, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error("[notification] create error:", err.message);
  }
}

// ── Notifications endpoints ───────────────────────────────────────────────────

router.get("/notifications", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Get notifications error:", err.message);
    return res.status(500).json({ success: false, message: "Error fetching notifications" });
  }
});

router.post("/notifications/:id/read", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[notifications] mark read error:", err.message);
    return res.status(500).json({ success: false, message: "Error marking notification read" });
  }
});

router.post("/notifications/read-all", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE user_id = $1`,
      [req.user.id]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[notifications] mark all read error:", err.message);
    return res.status(500).json({ success: false, message: "Error marking all notifications read" });
  }
});

router.delete("/notifications/:id", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[notifications] delete error:", err.message);
    return res.status(500).json({ success: false, message: "Error deleting notification" });
  }
});

router.delete("/notifications/all", authenticateToken, async (req, res) => {
  try {
    await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [req.user.id]);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[notifications] delete all error:", err.message);
    return res.status(500).json({ success: false, message: "Error deleting notifications" });
  }
});

module.exports = { router, createNotification };
