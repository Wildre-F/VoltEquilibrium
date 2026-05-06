// Authentication middleware
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("./constants");

function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, message: "Access token required" });
    }
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authorisation header must start with Bearer" });
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ success: false, message: "Token not provided" });
    }
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    console.error("[auth] token verification failed:", err.message);
    return res.status(403).json({ success: false, message: "Invalid or expired token" });
  }
}

module.exports = { authenticateToken };
