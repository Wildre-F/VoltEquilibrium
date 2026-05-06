const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateToken } = require("../helpers/auth");
const { getOrCreateWallet } = require("../helpers/wallet");
const { PF_MERCHANT_ID, PF_MERCHANT_KEY, PF_HOST, PF_RETURN_URL, PF_CANCEL_URL, PF_SANDBOX } = require("../helpers/constants");

router.get("/", authenticateToken, async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.user.id);
    return res.status(200).json({ success: true, data: wallet });
  } catch (err) {
    console.error("[wallet] fetch wallet error:", err.message);
    return res.status(500).json({ success: false, message: "Error fetching wallet" });
  }
});

router.get("/transactions", authenticateToken, async (req, res) => {
  try {
    await getOrCreateWallet(req.user.id);
    const result = await pool.query(
      `SELECT wt.*, u.username AS counter_party_name
       FROM wallet_transactions wt
       LEFT JOIN users u ON u.id = wt.counter_party_id
       WHERE wt.user_id = $1
       ORDER BY wt.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error("[wallet] fetch transactions error:", err.message);
    return res.status(500).json({ success: false, message: "Error fetching transactions" });
  }
});

// POST /payfast/initiate — create pending payment + return form fields for redirect
router.post("/payfast/initiate", authenticateToken, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < 1 || amount > 10000) {
      return res.status(400).json({ success: false, message: "Amount must be between R1 and R10,000" });
    }
    const mPaymentId = `VE-${req.user.id}-${Date.now()}`;

    await pool.query(
      `INSERT INTO payfast_payments (user_id, m_payment_id, amount) VALUES ($1, $2, $3)`,
      [req.user.id, mPaymentId, amount.toFixed(2)],
    );

    // Form fields for PayFast — no signature needed for sandbox
    const formFields = {
      merchant_id:  PF_MERCHANT_ID,
      merchant_key: PF_MERCHANT_KEY,
      return_url:   PF_RETURN_URL,
      cancel_url:   PF_CANCEL_URL,
      m_payment_id: mPaymentId,
      amount:       amount.toFixed(2),
      item_name:    "VoltEquilibrium Wallet Top-Up",
    };

    return res.json({
      success: true,
      data: { payfast_url: PF_HOST, form_fields: formFields },
    });
  } catch (err) {
    console.error("PayFast initiate error:", err.message);
    return res.status(500).json({ success: false, message: "Error initiating payment" });
  }
});

// POST /payfast/notify — ITN callback from PayFast (server-to-server)
router.post("/payfast/notify", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { m_payment_id, pf_payment_id, payment_status, amount_gross } = req.body;
    if (payment_status !== "COMPLETE") return res.status(200).send("OK");

    const payment = await pool.query(
      `SELECT * FROM payfast_payments WHERE m_payment_id = $1 AND status = 'pending'`,
      [m_payment_id],
    );
    if (payment.rows.length === 0) return res.status(200).send("OK");

    const row    = payment.rows[0];
    const amount = parseFloat(amount_gross || row.amount);

    await pool.query(`UPDATE payfast_payments SET status = 'complete', pf_payment_id = $1 WHERE id = $2`, [pf_payment_id, row.id]);

    const wallet = await getOrCreateWallet(row.user_id);
    const newBal = parseFloat(wallet.balance) + amount;
    await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBal.toFixed(2), row.user_id]);
    await pool.query(
      `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description)
       VALUES ($1,'top_up','credit',$2,$3,$4)`,
      [row.user_id, amount.toFixed(2), newBal.toFixed(2), `PayFast payment ${m_payment_id}`],
    );

    return res.status(200).send("OK");
  } catch (err) {
    console.error("PayFast ITN error:", err.message);
    return res.status(200).send("OK");
  }
});

// GET /payfast/status/:id — check payment status (+ sandbox auto-confirm)
router.get("/payfast/status/:id", authenticateToken, async (req, res) => {
  try {
    const payment = await pool.query(
      `SELECT * FROM payfast_payments WHERE m_payment_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (payment.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const row = payment.rows[0];

    // Sandbox auto-confirm: if still pending and sandbox mode, credit the wallet automatically
    if (row.status === "pending" && PF_SANDBOX) {
      const amount = parseFloat(row.amount);
      await pool.query(`UPDATE payfast_payments SET status = 'complete' WHERE id = $1`, [row.id]);

      const wallet = await getOrCreateWallet(row.user_id);
      const newBal = parseFloat(wallet.balance) + amount;
      await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBal.toFixed(2), row.user_id]);
      await pool.query(
        `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description)
         VALUES ($1,'top_up','credit',$2,$3,$4)`,
        [row.user_id, amount.toFixed(2), newBal.toFixed(2), `PayFast payment ${row.m_payment_id}`],
      );

      return res.json({ success: true, data: { status: "complete", amount: amount.toFixed(2) } });
    }

    return res.json({ success: true, data: { status: row.status, amount: parseFloat(row.amount).toFixed(2) } });
  } catch (err) {
    console.error("PayFast status error:", err.message);
    return res.status(500).json({ success: false, message: "Error checking payment status" });
  }
});

router.post("/withdraw", authenticateToken, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0 || amount > 10000) {
      return res.status(400).json({ success: false, message: "Amount must be between R0.01 and R10,000" });
    }
    const wallet = await getOrCreateWallet(req.user.id);
    const currentBal = parseFloat(wallet.balance);
    if (currentBal < amount) {
      return res.status(400).json({ success: false, message: `Insufficient balance (R${currentBal.toFixed(2)} available)` });
    }
    const newBal = currentBal - amount;
    await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newBal.toFixed(2), req.user.id]);
    await pool.query(
      `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description)
       VALUES ($1,'withdraw','debit',$2,$3,'Funds withdrawn')`,
      [req.user.id, amount.toFixed(2), newBal.toFixed(2)]
    );
    return res.status(200).json({ success: true, data: { balance: newBal.toFixed(2) } });
  } catch (err) {
    console.error("[wallet] withdraw error:", err.message);
    return res.status(500).json({ success: false, message: "Error withdrawing funds" });
  }
});

module.exports = router;
