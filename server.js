const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const passport = require("passport");

dotenv.config();
require("./models/passport");

const app = express();
const PORT = process.env.PORT || 5000;

// Environment configuration
const isProduction = process.env.NODE_ENV === "production";

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      "https://contactpro-hrmanager.vercel.app",
      "https://mv-main-client.vercel.app",
      "https://dalilyai.com",
    ];

    if (process.env.FRONTEND_URL) {
      allowedOrigins.push(process.env.FRONTEND_URL);
    }

    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  optionsSuccessStatus: 200,
};

// Trust proxy for Vercel
if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(passport.initialize());

// Request logging middleware
if (!isProduction) {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
    next();
  });
}

// Health check routes
app.get("/", (req, res) => {
  res.status(200).json({
    message: "ContactPro API is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    version: "1.0.0",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

const dashboardRoutes = require("./routes/dashboardRoutes");
const auth = require("./routes/auth");
const profileRoutes = require("./routes/profileRoutes");
const linkedinScraper = require("./routes/linkedinScraper");

// API Routes with error boundary
app.use("/auth", auth);
app.use("/api/dashboard", dashboardRoutes);
app.use("/profiles", profileRoutes);
app.use("/api", linkedinScraper);

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error("Global error handler:", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(err.status || 500).json({
    message: isProduction ? "Internal server error" : err.message,
    error: isProduction
      ? {}
      : {
          message: err.message,
          stack: err.stack,
        },
  });
});

// 404 handler - FIXED for Express 5.x compatibility
// Changed from '*' to '/:catchAll*' to provide a parameter name
app.use("/:catchAll*", (req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    message: "Route not found",
    path: req.originalUrl,
    method: req.method,
  });
});

// MongoDB connection with retry logic
const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI environment variable is not set");
    }

    const options = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
    };

    await mongoose.connect(process.env.MONGO_URI, options);
    console.log("✅ Connected to MongoDB");

    // Handle connection events
    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB connection error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected");
    });
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error.message);

    // Don't exit in production to allow container restart
    if (!isProduction) {
      process.exit(1);
    }

    // Retry connection after delay in production
    setTimeout(connectDB, 5000);
  }
};

// Graceful shutdown handling
const gracefulShutdown = () => {
  console.log("🛑 Received shutdown signal, closing server gracefully...");

  mongoose.connection.close(() => {
    console.log("📦 MongoDB connection closed");
    process.exit(0);
  });
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Start server
const startServer = async () => {
  try {
    await connectDB();

    if (!isProduction) {
      const server = app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📊 Dashboard API: http://localhost:${PORT}/api/dashboard`);
        console.log(`👥 Profiles API: http://localhost:${PORT}/profiles`);
        console.log(
          `🔗 LinkedIn Scraper API: http://localhost:${PORT}/api/scrape-linkedin`
        );
      });

      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.error(`❌ Port ${PORT} is already in use`);
          process.exit(1);
        }
        throw err;
      });
    }
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

// Initialize
if (!isProduction) {
  startServer();
} else {
  // For Vercel, just ensure DB connection
  connectDB().catch(console.error);
}

// Export for Vercel
module.exports = app;
