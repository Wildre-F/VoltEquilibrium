// Shared constants for VoltEquilibrium backend
const crypto = require("crypto");

// Energy & tariff
const CO2_KG_PER_KWH = 0.928;
const RANDS_PER_KWH  = 2.5;

// Community sharing caps
const NO_BATTERY_MAX_PER_REQUEST  = 2;
const NO_BATTERY_MAX_OUTSTANDING  = 10;

// PayFast
const PF_MERCHANT_ID  = process.env.PAYFAST_MERCHANT_ID  || "10000100";
const PF_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || "46f0cd694581a";
const PF_PASSPHRASE   = process.env.PAYFAST_PASSPHRASE   || "jt7NOE43FZPn";
const PF_SANDBOX      = process.env.PAYFAST_SANDBOX === "true";
const PF_HOST         = PF_SANDBOX ? "https://sandbox.payfast.co.za/eng/process" : "https://www.payfast.co.za/eng/process";
const PF_RETURN_URL   = process.env.PAYFAST_RETURN_URL  || "http://localhost:9090/frontend/Wallet.html?payment=success";
const PF_CANCEL_URL   = process.env.PAYFAST_CANCEL_URL  || "http://localhost:9090/frontend/Wallet.html?payment=cancelled";
const PF_NOTIFY_URL   = process.env.PAYFAST_NOTIFY_URL  || "http://localhost:3000/api/wallet/payfast/notify";

// Ollama
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";

// JWT
const JWT_SECRET = process.env.JWT_SECRET;

// Weather cache TTL
const WEATHER_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const WEATHER_CACHE_MAX_AGE = 30 * 60 * 1000; // 30 minutes prune

// PayFast signature
function generatePayfastSignature(data) {
  const pfOutput = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && val !== "") {
      pfOutput.push(`${key}=${String(val).trim()}`);
    }
  }
  let pfParamString = pfOutput.join("&");
  if (PF_PASSPHRASE) {
    pfParamString += `&passphrase=${PF_PASSPHRASE.trim()}`;
  }
  return crypto.createHash("md5").update(pfParamString).digest("hex");
}

module.exports = {
  CO2_KG_PER_KWH, RANDS_PER_KWH,
  NO_BATTERY_MAX_PER_REQUEST, NO_BATTERY_MAX_OUTSTANDING,
  PF_MERCHANT_ID, PF_MERCHANT_KEY, PF_PASSPHRASE, PF_SANDBOX, PF_HOST,
  PF_RETURN_URL, PF_CANCEL_URL, PF_NOTIFY_URL,
  OLLAMA_URL, JWT_SECRET,
  WEATHER_CACHE_TTL, WEATHER_CACHE_MAX_AGE,
  generatePayfastSignature,
};
