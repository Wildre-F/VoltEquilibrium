// Shared wallet helper functions
const pool = require("../db");

async function getOrCreateWallet(userId) {
  await pool.query(
    `INSERT INTO wallets (user_id, balance) VALUES ($1, 0.00) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const result = await pool.query(`SELECT * FROM wallets WHERE user_id = $1`, [userId]);
  return result.rows[0];
}

async function transferWallet(fromUserId, toUserId, amount, description) {
  const fromWallet = await getOrCreateWallet(fromUserId);
  const toWallet   = await getOrCreateWallet(toUserId);

  const fromBal = parseFloat(fromWallet.balance);
  if (fromBal < amount) {
    throw new Error(`Insufficient balance (R${fromBal.toFixed(2)} available)`);
  }

  const newFromBal = fromBal - amount;
  const newToBal   = parseFloat(toWallet.balance) + amount;

  await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newFromBal.toFixed(2), fromUserId]);
  await pool.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2`, [newToBal.toFixed(2), toUserId]);

  await pool.query(
    `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description, counter_party_id)
     VALUES ($1, 'transfer', 'debit', $2, $3, $4, $5)`,
    [fromUserId, amount.toFixed(2), newFromBal.toFixed(2), description, toUserId]
  );
  await pool.query(
    `INSERT INTO wallet_transactions (user_id, type, direction, amount, balance_after, description, counter_party_id)
     VALUES ($1, 'transfer', 'credit', $2, $3, $4, $5)`,
    [toUserId, amount.toFixed(2), newToBal.toFixed(2), description, fromUserId]
  );
}

module.exports = { getOrCreateWallet, transferWallet };
