const express = require("express");
const router  = express.Router();
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const pool    = require("../db");
const launcher = require("../launcher");
const { authenticateToken } = require("../helpers/auth");
const { JWT_SECRET } = require("../helpers/constants");

// ═══════════════════════════════════════════════════════════════════════════
// Profile & Account Routes
// ═══════════════════════════════════════════════════════════════════════════

router.get("/profile", authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, avatar_color, created_at FROM users WHERE id = $1",
      [req.user.id],
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({ success: true, message: "Profile retrieved successfully", data: user });
  } catch (error) {
    next(error);
  }
});

router.put("/profile/update", authenticateToken, async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email) {
      return res.status(400).json({ success: false, message: "Username and email are required" });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 AND id != $2",
      [email.trim().toLowerCase(), req.user.id],
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Email already in use by another account" });
    }

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query(
        "UPDATE users SET username = $1, email = $2, password = $3 WHERE id = $4",
        [username, email.trim().toLowerCase(), hashedPassword, req.user.id],
      );
    } else {
      await pool.query(
        "UPDATE users SET username = $1, email = $2 WHERE id = $3",
        [username, email.trim().toLowerCase(), req.user.id],
      );
    }

    return res.status(200).json({ success: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update profile error:", error.message);
    return res.status(500).json({ success: false, message: "Error updating profile" });
  }
});

router.put("/profile/avatar-color", authenticateToken, async (req, res) => {
  try {
    const { color } = req.body;
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ success: false, message: "Invalid color format" });
    }
    await pool.query("UPDATE users SET avatar_color = $1 WHERE id = $2", [color, req.user.id]);
    return res.json({ success: true });
  } catch (error) {
    console.error("Avatar color error:", error.message);
    return res.status(500).json({ success: false, message: "Error updating avatar color" });
  }
});

router.put("/profile/location", authenticateToken, async (req, res) => {
  try {
    const { location, lat, lng } = req.body;

    if (lat == null || lng == null) {
      return res.status(400).json({ success: false, message: "lat and lng are required" });
    }

    await pool.query(
      "UPDATE users SET location = $1, lat = $2, lng = $3 WHERE id = $4",
      [location || null, parseFloat(lat), parseFloat(lng), req.user.id],
    );

    // Restart simulators with the new coordinates so weather adjusts immediately
    const userRow  = await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id]);
    const inverters = await pool.query("SELECT id, profile FROM inverters WHERE user_id = $1", [req.user.id]);

    if (userRow.rows[0]?.api_key && inverters.rows.length > 0) {
      const simToken = jwt.sign(
        { id: req.user.id, role: "generator", purpose: "simulator" },
        JWT_SECRET,
        { expiresIn: "30d" },
      );
      launcher.stopAllForUser(userRow.rows[0].api_key);
      setTimeout(() => {
        inverters.rows.forEach((inv) => {
          launcher.startSimulator({
            apiKey:   userRow.rows[0].api_key,
            profile:  inv.profile,
            lat:      parseFloat(lat),
            lng:      parseFloat(lng),
            token:    simToken,
            deviceId: inv.id,
          });
        });
      }, 1000);
    }

    return res.status(200).json({ success: true, message: "Location updated" });
  } catch (error) {
    console.error("Location update error:", error.message);
    return res.status(500).json({ success: false, message: "Error updating location" });
  }
});

router.get("/user/apikey", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id]);
    return res.status(200).json({ success: true, apiKey: result.rows[0].api_key });
  } catch (error) {
    console.error("API key error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching API key" });
  }
});

// Delete all generated data but keep the account
router.delete("/account/data", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const userKeyRow = await pool.query("SELECT api_key FROM users WHERE id = $1", [userId]);
    if (userKeyRow.rows[0]?.api_key) {
      launcher.stopAllForUser(userKeyRow.rows[0].api_key);
    }

    // Delete in FK-safe order
    await pool.query(
      "DELETE FROM battery_readings WHERE battery_id IN (SELECT id FROM batteries WHERE user_id = $1)",
      [userId],
    );
    await pool.query("DELETE FROM batteries WHERE user_id = $1", [userId]);
    await pool.query(
      "DELETE FROM energy_readings WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)",
      [userId],
    );
    await pool.query(
      "DELETE FROM raw_readings WHERE inverter_id IN (SELECT id FROM inverters WHERE user_id = $1)",
      [userId],
    );
    await pool.query("DELETE FROM inverters WHERE user_id = $1", [userId]);
    await pool.query("UPDATE users SET api_key = NULL, role = 'consumer' WHERE id = $1", [userId]);

    return res.status(200).json({ success: true, message: "All data deleted successfully" });
  } catch (error) {
    console.error("Delete data error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting data" });
  }
});

// Delete the entire account (cascades to all data via FK ON DELETE CASCADE)
router.delete("/account", authenticateToken, async (req, res) => {
  try {
    const userId     = req.user.id;
    const userKeyRow = await pool.query("SELECT api_key FROM users WHERE id = $1", [userId]);

    if (userKeyRow.rows[0]?.api_key) {
      launcher.stopAllForUser(userKeyRow.rows[0].api_key);
    }

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    return res.status(200).json({ success: true, message: "Account deleted successfully" });
  } catch (error) {
    console.error("Delete account error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting account" });
  }
});

// PUT /profile/power-source — toggle between grid and battery
router.put("/profile/power-source", authenticateToken, async (req, res) => {
  try {
    const { source } = req.body;
    if (!["grid", "battery"].includes(source)) {
      return res.status(400).json({ success: false, message: "Source must be 'grid' or 'battery'" });
    }
    await pool.query("UPDATE users SET power_source = $1 WHERE id = $2", [source, req.user.id]);
    return res.json({ success: true, data: { power_source: source } });
  } catch (err) {
    console.error("Power source update error:", err.message);
    return res.status(500).json({ success: false, message: "Error updating power source" });
  }
});

module.exports = router;
