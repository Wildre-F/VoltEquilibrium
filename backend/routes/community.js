const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateToken } = require("../helpers/auth");
const { isSameArea, getUserSoc, getUserShareableKwh, getUserRequestableKwh, applyEnergyTransfer } = require("../helpers/energy");
const { transferWallet } = require("../helpers/wallet");
const { createNotification } = require("./notifications");
const { NO_BATTERY_MAX_PER_REQUEST, NO_BATTERY_MAX_OUTSTANDING } = require("../helpers/constants");

// ── Donations ─────────────────────────────────────────────────────────────────

router.get("/donations", authenticateToken, async (req, res) => {
  try {
    const meResult = await pool.query(
      "SELECT location, lat, lng FROM users WHERE id = $1",
      [req.user.id]
    );
    const me = meResult.rows[0];

    const result = await pool.query(
      `SELECT d.*, u.username, u.location, u.lat, u.lng
       FROM donations d
       JOIN users u ON d.user_id = u.id
       WHERE d.is_filled = FALSE
       ORDER BY d.created_at DESC`,
      []
    );

    return res.status(200).json({ success: true, data: result.rows.filter((row) => row.user_id === req.user.id || isSameArea(me, row)) });
  } catch (error) {
    console.error("Get donations error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching donations" });
  }
});

router.post("/donations", authenticateToken, async (req, res) => {
  try {
    const { amount_kwh } = req.body;
    if (!amount_kwh || amount_kwh <= 0) {
      return res.status(400).json({ success: false, message: "amount_kwh must be greater than 0" });
    }

    const soc = await getUserSoc(req.user.id);
    if (soc === null) {
      return res.status(400).json({ success: false, message: "No battery data found. Please set up an inverter first." });
    }
    if (soc <= 30) {
      return res.status(400).json({ success: false, message: `Insufficient battery charge (${soc}% SOC). Minimum 30% required.` });
    }

    const result = await pool.query(
      `INSERT INTO donations (user_id, amount_kwh) VALUES ($1, $2) RETURNING *`,
      [req.user.id, amount_kwh]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Create donation error:", error.message);
    return res.status(500).json({ success: false, message: "Error creating donation" });
  }
});

router.delete("/donations/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM donations WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: "Donation not found or not yours" });
    }
    if (result.rows[0].is_filled) {
      return res.status(400).json({ success: false, message: "Cannot delete a filled donation" });
    }

    await pool.query("DELETE FROM donations WHERE id = $1", [req.params.id]);
    return res.status(200).json({ success: true, message: "Donation deleted" });
  } catch (error) {
    console.error("Delete donation error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting donation" });
  }
});

router.post("/donations/:id/fill", authenticateToken, async (req, res) => {
  try {
    const donationResult = await pool.query(
      `SELECT d.*, u.lat, u.lng, u.location
       FROM donations d
       JOIN users u ON d.user_id = u.id
       WHERE d.id = $1`,
      [req.params.id]
    );

    if (!donationResult.rows[0]) {
      return res.status(404).json({ success: false, message: "Donation not found" });
    }
    const donation = donationResult.rows[0];

    if (donation.user_id === req.user.id) {
      return res.status(400).json({ success: false, message: "Cannot accept your own donation" });
    }
    if (donation.is_filled) {
      return res.status(400).json({ success: false, message: "Donation already filled" });
    }

    const meResult = await pool.query(
      "SELECT lat, lng, location FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!isSameArea(meResult.rows[0], donation)) {
      return res.status(403).json({ success: false, message: "Transfers only permitted within the same geographic area" });
    }

    const donorSoc = await getUserSoc(donation.user_id);
    if (donorSoc === null || donorSoc <= 30) {
      return res.status(400).json({ success: false, message: `Donor's battery is insufficient (${donorSoc}% SOC). Minimum 30% required.` });
    }

    const result = await pool.query(
      `UPDATE donations SET is_filled = TRUE, filled_by_user_id = $1 WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Fill donation error:", error.message);
    return res.status(500).json({ success: false, message: "Error filling donation" });
  }
});

// ── Energy Sales ──────────────────────────────────────────────────────────────

router.get("/sales", authenticateToken, async (req, res) => {
  try {
    const meResult = await pool.query(
      "SELECT location, lat, lng FROM users WHERE id = $1",
      [req.user.id]
    );
    const me = meResult.rows[0];

    const result = await pool.query(
      `SELECT s.*, u.username, u.location, u.lat, u.lng
       FROM energy_sales s
       JOIN users u ON s.user_id = u.id
       WHERE s.is_filled = FALSE
       ORDER BY s.created_at DESC`,
      []
    );

    return res.status(200).json({ success: true, data: result.rows.filter((row) => row.user_id === req.user.id || isSameArea(me, row)) });
  } catch (error) {
    console.error("Get sales error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching sales" });
  }
});

router.post("/sales", authenticateToken, async (req, res) => {
  try {
    const { amount_kwh, price_per_kwh } = req.body;
    if (!amount_kwh || amount_kwh <= 0) {
      return res.status(400).json({ success: false, message: "amount_kwh must be greater than 0" });
    }
    if (!price_per_kwh || price_per_kwh <= 0) {
      return res.status(400).json({ success: false, message: "price_per_kwh must be greater than 0" });
    }

    const battery = await getUserShareableKwh(req.user.id);
    if (!battery) {
      return res.status(400).json({ success: false, message: "No battery data found. Please set up an inverter first." });
    }
    if (battery.soc <= 30) {
      return res.status(400).json({ success: false, message: `Insufficient battery charge (${battery.soc.toFixed(1)}% SOC). Minimum 30% required.` });
    }
    if (amount_kwh > battery.availableKwh) {
      return res.status(400).json({ success: false, message: `Cannot list ${amount_kwh} kWh — only ${battery.availableKwh.toFixed(2)} kWh available after existing listings.` });
    }

    const { comment } = req.body;
    const result = await pool.query(
      `INSERT INTO energy_sales (user_id, amount_kwh, price_per_kwh, comment) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, amount_kwh, price_per_kwh, comment || null]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Create sale error:", error.message);
    return res.status(500).json({ success: false, message: "Error creating sale" });
  }
});

router.delete("/sales/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM energy_sales WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: "Sale not found or not yours" });
    }
    if (result.rows[0].is_filled) {
      return res.status(400).json({ success: false, message: "Cannot delete a completed sale" });
    }

    await pool.query("DELETE FROM energy_sales WHERE id = $1", [req.params.id]);
    return res.status(200).json({ success: true, message: "Sale listing deleted" });
  } catch (error) {
    console.error("Delete sale error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting sale" });
  }
});

router.post("/sales/:id/fill", authenticateToken, async (req, res) => {
  try {
    const saleResult = await pool.query(
      `SELECT s.*, u.lat, u.lng, u.location
       FROM energy_sales s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1`,
      [req.params.id]
    );

    if (!saleResult.rows[0]) {
      return res.status(404).json({ success: false, message: "Sale not found" });
    }
    const sale = saleResult.rows[0];

    if (sale.user_id === req.user.id) {
      return res.status(400).json({ success: false, message: "Cannot buy your own sale listing" });
    }
    if (sale.is_filled) {
      return res.status(400).json({ success: false, message: "Sale already completed" });
    }

    const meResult = await pool.query(
      "SELECT lat, lng, location FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!isSameArea(meResult.rows[0], sale)) {
      return res.status(403).json({ success: false, message: "Transfers only permitted within the same geographic area" });
    }

    const sellerSoc = await getUserSoc(sale.user_id);
    if (sellerSoc === null || sellerSoc <= 30) {
      return res.status(400).json({ success: false, message: `Seller's battery is insufficient (${sellerSoc}% SOC). Minimum 30% required.` });
    }

    // Check buyer has enough empty battery space to receive the energy
    const buyerSpace = await getUserRequestableKwh(req.user.id);
    if (buyerSpace === null) {
      return res.status(400).json({ success: false, message: "No battery data found for your account. Please set up an inverter first." });
    }
    if (parseFloat(sale.amount_kwh) > buyerSpace) {
      return res.status(400).json({ success: false, message: `Not enough battery space to receive ${sale.amount_kwh} kWh — you only have ${buyerSpace.toFixed(2)} kWh of free capacity.` });
    }

    const result = await pool.query(
      `UPDATE energy_sales SET is_filled = TRUE, filled_by_user_id = $1 WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );

    // Wallet transfer: buyer pays seller
    const total = (parseFloat(sale.amount_kwh) * parseFloat(sale.price_per_kwh)).toFixed(2);
    await transferWallet(req.user.id, sale.user_id, parseFloat(total),
      `Energy purchase: ${sale.amount_kwh} kWh @ R${parseFloat(sale.price_per_kwh).toFixed(2)}/kWh`);

    // Adjust battery SOC for both parties and record grid export for seller
    await applyEnergyTransfer(sale.user_id, req.user.id, parseFloat(sale.amount_kwh));

    // Notify the seller
    const buyerRow = await pool.query("SELECT username FROM users WHERE id = $1", [req.user.id]);
    const buyerName  = buyerRow.rows[0]?.username || "Someone";
    await createNotification(
      sale.user_id,
      "sale_completed",
      "Energy Sale Completed",
      `${buyerName} purchased ${sale.amount_kwh} kWh for R${total}.`,
      { sale_id: sale.id, buyer_id: req.user.id, amount_kwh: sale.amount_kwh, total_rands: total }
    );
    // Notify the buyer
    const sellerRow = await pool.query("SELECT username FROM users WHERE id = $1", [sale.user_id]);
    const sellerName = sellerRow.rows[0]?.username || "Someone";
    await createNotification(
      req.user.id,
      "purchase_completed",
      "Energy Purchase Confirmed",
      `You bought ${sale.amount_kwh} kWh from ${sellerName} for R${total}. Your battery has been updated.`,
      { sale_id: sale.id, seller_id: sale.user_id, amount_kwh: sale.amount_kwh, total_rands: total }
    );

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Fill sale error:", error.message);
    return res.status(500).json({ success: false, message: "Error completing sale" });
  }
});

// ── Energy Requests ───────────────────────────────────────────────────────────

router.get("/requests", authenticateToken, async (req, res) => {
  try {
    const meResult = await pool.query(
      "SELECT location, lat, lng FROM users WHERE id = $1",
      [req.user.id]
    );
    const me = meResult.rows[0];

    const result = await pool.query(
      `SELECT r.*, u.username, u.location, u.lat, u.lng
       FROM energy_requests r
       JOIN users u ON r.user_id = u.id
       WHERE r.is_filled = FALSE
       ORDER BY r.created_at DESC`,
      []
    );

    return res.status(200).json({ success: true, data: result.rows.filter((row) => row.user_id === req.user.id || isSameArea(me, row)) });
  } catch (error) {
    console.error("Get requests error:", error.message);
    return res.status(500).json({ success: false, message: "Error fetching requests" });
  }
});

router.post("/requests", authenticateToken, async (req, res) => {
  try {
    const { amount_kwh } = req.body;
    if (!amount_kwh || amount_kwh <= 0) {
      return res.status(400).json({ success: false, message: "amount_kwh must be greater than 0" });
    }

    const requestable = await getUserRequestableKwh(req.user.id);
    if (requestable !== null && typeof requestable === "object" && requestable.noBattery) {
      // No-battery user: apply community caps
      if (amount_kwh > NO_BATTERY_MAX_PER_REQUEST) {
        return res.status(400).json({ success: false, message: `Users without a battery can request at most ${NO_BATTERY_MAX_PER_REQUEST} kWh per request.` });
      }
      if (amount_kwh > requestable.remaining) {
        return res.status(400).json({ success: false, message: `You have ${requestable.remaining.toFixed(2)} kWh of your ${NO_BATTERY_MAX_OUTSTANDING} kWh community allowance remaining.` });
      }
    } else {
      if (amount_kwh > requestable) {
        return res.status(400).json({ success: false, message: `Cannot request ${amount_kwh} kWh — only ${requestable.toFixed(2)} kWh of battery space available after existing requests.` });
      }
    }

    const { comment } = req.body;
    const result = await pool.query(
      `INSERT INTO energy_requests (user_id, amount_kwh, comment) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, amount_kwh, comment || null]
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Create request error:", error.message);
    return res.status(500).json({ success: false, message: "Error creating request" });
  }
});

router.delete("/requests/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM energy_requests WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: "Request not found or not yours" });
    }
    if (result.rows[0].is_filled) {
      return res.status(400).json({ success: false, message: "Cannot delete a filled request" });
    }

    await pool.query("DELETE FROM energy_requests WHERE id = $1", [req.params.id]);
    return res.status(200).json({ success: true, message: "Request deleted" });
  } catch (error) {
    console.error("Delete request error:", error.message);
    return res.status(500).json({ success: false, message: "Error deleting request" });
  }
});

router.post("/requests/:id/fill", authenticateToken, async (req, res) => {
  try {
    const requestResult = await pool.query(
      `SELECT r.*, u.lat, u.lng, u.location
       FROM energy_requests r
       JOIN users u ON r.user_id = u.id
       WHERE r.id = $1`,
      [req.params.id]
    );

    if (!requestResult.rows[0]) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    const request = requestResult.rows[0];

    if (request.user_id === req.user.id) {
      return res.status(400).json({ success: false, message: "Cannot fill your own request" });
    }
    if (request.is_filled) {
      return res.status(400).json({ success: false, message: "Request already filled" });
    }

    const meResult = await pool.query(
      "SELECT lat, lng, location FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!isSameArea(meResult.rows[0], request)) {
      return res.status(403).json({ success: false, message: "Transfers only permitted within the same geographic area" });
    }

    const fillerSoc = await getUserSoc(req.user.id);
    if (fillerSoc === null) {
      return res.status(400).json({ success: false, message: "No battery data found. Please set up an inverter first." });
    }
    if (fillerSoc <= 30) {
      return res.status(400).json({ success: false, message: `Insufficient battery charge (${fillerSoc}% SOC). Minimum 30% required to fulfill a request.` });
    }

    // Check that the requester actually has space to receive it (skip for no-battery users)
    // Add back this request's amount since it's counted in "unfilled" but is about to be filled
    const requesterSpace = await getUserRequestableKwh(request.user_id);
    const adjustedSpace = (typeof requesterSpace === "number") ? requesterSpace + parseFloat(request.amount_kwh) : null;
    if (adjustedSpace !== null && parseFloat(request.amount_kwh) > adjustedSpace) {
      return res.status(400).json({ success: false, message: `The requester's battery no longer has enough space for ${request.amount_kwh} kWh (only ${adjustedSpace.toFixed(2)} kWh free).` });
    }

    const donorComment = req.body?.comment?.trim() || null;
    const result = await pool.query(
      `UPDATE energy_requests SET is_filled = TRUE, filled_by_user_id = $1, donor_comment = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, donorComment, req.params.id]
    );

    // Adjust SOC: filler (donor) sends energy to requester
    await applyEnergyTransfer(req.user.id, request.user_id, parseFloat(request.amount_kwh));

    // Notify the requester
    const fillerRow = await pool.query("SELECT username FROM users WHERE id = $1", [req.user.id]);
    const fillerName = fillerRow.rows[0]?.username || "Someone";
    const fulfilledMsg = donorComment
      ? `${fillerName} donated ${request.amount_kwh} kWh to your request: "${donorComment}"`
      : `${fillerName} donated ${request.amount_kwh} kWh to your request. Your battery has been updated.`;
    await createNotification(
      request.user_id,
      "request_fulfilled",
      "Energy Request Fulfilled",
      fulfilledMsg,
      { request_id: request.id, filler_id: req.user.id, amount_kwh: request.amount_kwh }
    );
    // Notify the donor
    const requesterRow = await pool.query("SELECT username FROM users WHERE id = $1", [request.user_id]);
    const requesterName = requesterRow.rows[0]?.username || "Someone";
    await createNotification(
      req.user.id,
      "donation_sent",
      "Donation Sent",
      `You donated ${request.amount_kwh} kWh to ${requesterName}'s request. Thank you!`,
      { request_id: request.id, recipient_id: request.user_id, amount_kwh: request.amount_kwh }
    );

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Fill request error:", error.message);
    return res.status(500).json({ success: false, message: "Error filling request" });
  }
});

module.exports = router;
