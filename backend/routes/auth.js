const express    = require("express");
const router     = express.Router();
const crypto     = require("crypto");
const bcrypt     = require("bcrypt");
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const rateLimit  = require("express-rate-limit");
const pool       = require("../db");
const passport   = require("../passport");
const { JWT_SECRET } = require("../helpers/constants");

// ═══════════════════════════════════════════════════════════════════════════
// Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts, please try again later",
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth Routes
// ═══════════════════════════════════════════════════════════════════════════

router.post("/api/register", authLimiter, async (req, res) => {
  try {
    const cleanUsername = req.body.username?.trim();
    const cleanEmail    = req.body.email?.trim().toLowerCase();
    const { password }  = req.body;

    if (!cleanUsername || !cleanEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Username, email, and password are required",
      });
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, email, password)
       VALUES ($1, $2, $3)
       RETURNING id, username, email`,
      [cleanUsername, cleanEmail, hashedPassword],
    );

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Register error:", error.message);
    return res.status(500).json({ success: false, message: "Server error during registration" });
  }
});

router.post("/api/login", authLimiter, async (req, res, next) => {
  try {
    const cleanEmail   = req.body.email?.trim().toLowerCase();
    const { password } = req.body;

    if (!cleanEmail || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const result = await pool.query(
      "SELECT id, username, email, password, role FROM users WHERE email = $1",
      [cleanEmail],
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ success: false, message: "Account not found, please register first" });
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);
    if (!isPasswordMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    return res.status(200).json({ success: true, message: "Login successful", token });
  } catch (error) {
    next(error);
  }
});

// ── Google OAuth ─────────────────────────────────────────────────────────────

router.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

router.get(
  "/auth/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/login.html" }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email, username: req.user.username, role: req.user.role },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    res.redirect(`${process.env.FRONTEND_URL}/frontend/splash.html?token=${token}`);
  },
);

// ── Password Reset ────────────────────────────────────────────────────────────

router.post("/api/forgot-password", authLimiter, async (req, res) => {
  try {
    const cleanEmail = req.body.email?.trim().toLowerCase();

    if (!cleanEmail) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const result = await pool.query(
      "SELECT id, username FROM users WHERE email = $1",
      [cleanEmail],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "No account found with that email" });
    }

    const user       = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetExpiry = new Date(Date.now() + 3_600_000); // 1 hour

    await pool.query(
      "UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3",
      [resetToken, resetExpiry, user.id],
    );

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    const resetLink = `${process.env.FRONTEND_URL}/frontend/reset-password.html?token=${resetToken}`;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: cleanEmail,
      subject: "VoltEquilibrium Password Reset",
      html: `
        <h2>Password Reset Request</h2>
        <p>Hi ${user.username},</p>
        <p>Click the link below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetLink}">Reset Password</a>
        <p>If you didn't request this, ignore this email.</p>
      `,
    });

    return res.status(200).json({ success: true, message: "Password reset email sent" });
  } catch (error) {
    console.error("Forgot password error:", error.message);
    return res.status(500).json({ success: false, message: "Error sending reset email" });
  }
});

router.post("/api/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, message: "Token and password are required" });
    }

    const result = await pool.query(
      "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()",
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid or expired reset token" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2",
      [hashedPassword, result.rows[0].id],
    );

    return res.status(200).json({ success: true, message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error.message);
    return res.status(500).json({ success: false, message: "Error resetting password" });
  }
});

module.exports = router;
