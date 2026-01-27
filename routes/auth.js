const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const User = require("../models/User");
const Nodemailer = require("nodemailer");
const Dashboard = require("../models/Dashboard");

const router = express.Router();

// Helper function to get redirect URLs
const getRedirectURL = (path) => {
  const baseURL =
    process.env.NODE_ENV === "production"
      ? process.env.FRONTEND_URL
      : "https://contactpro-hrmanager.vercel.app";
  return `${baseURL}${path}`;
};

// Helper function to create JWT token
const createToken = (userId, isAdmin, isSuperAdmin) => {
  return jwt.sign(
    { id: userId, isAdmin: isAdmin, isSuperAdmin: isSuperAdmin },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    },
  );
};

// Helper function to create user response object
const createUserResponse = (user) => {
  return {
    id: user._id || user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar || null,
    isAdmin: user.isAdmin || false,
    googleId: user.googleId || null,
    isSuperAdmin: user.isSuperAdmin || false,
  };
};

// Nodemailer
const sendEmail = async (options) => {
  const transporter = Nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  const emailOptions = {
    from: "Dalily_ai <dalilyaiweb@gmail.com>",
    to: options.email,
    subject: options.subject,
    text: options.text,
  };
  await transporter.sendMail(emailOptions);
};

// ==============================
// Email/Password request-signup
// ==============================
router.post("/request-signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Please provide all fields" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }

    // تحقق من عدم وجود حساب مفعل بنفس الإيميل
    const existingActiveUser = await User.findOne({
      email: email.toLowerCase().trim(),
      isVerified: true,
    });
    if (existingActiveUser) {
      return res.status(400).json({ message: "This email already exists" });
    }

    // تحقق من وجود طلب تسجيل سابق (لم ينتهِ)
    let pendingUser = await User.findOne({
      email: email.toLowerCase().trim(),
      isVerified: false,
    });

    const verificationCode = Math.floor(
      100000 + Math.random() * 900000,
    ).toString();
    const hashedCode = crypto
      .createHash("sha256")
      .update(verificationCode)
      .digest("hex");

    const userData = {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: await bcrypt.hash(password, 10),
      isVerified: false,
      verificationCode: hashedCode,
      verificationExpires: Date.now() + 10 * 60 * 1000, // 10 دقائق
    };

    if (pendingUser) {
      // تحديث الطلب السابق
      Object.assign(pendingUser, userData);
      await pendingUser.save();
    } else {
      // إنشاء طلب جديد
      pendingUser = await User.create(userData);
    }

    // إرسال الكود
    await sendEmail({
      email: userData.email,
      subject: "Verify Your Dalily.ai Account",
      text: `Hi ${userData.name},\nYour verification code is: ${verificationCode}\nThis code expires in 10 minutes.`,
    });

    res.json({ message: "Verification code sent to your email." });
  } catch (err) {
    console.error("Request signup error:", err);
    res.status(500).json({ message: "Failed to send verification code" });
  }
});

// ==============================
// Email/Password verify-signup
// ==============================
router.post("/verify-signup", async (req, res) => {
  try {
    const { email, verificationCode } = req.body;

    if (!email || !verificationCode) {
      return res
        .status(400)
        .json({ message: "Email and verification code are required" });
    }

    const user = await User.findOne({
      email: email.toLowerCase().trim(),
      isVerified: false,
    });

    if (!user || !user.verificationCode || !user.verificationExpires) {
      return res
        .status(400)
        .json({ message: "Invalid or expired verification code" });
    }

    // ⏰ تحقق من الصلاحية
    if (user.verificationExpires < Date.now()) {
      return res.status(400).json({
        message: "Verification code expired. Please request a new one.",
      });
    }

    // 🔐 تحقق من الكود
    const hashedCode = crypto
      .createHash("sha256")
      .update(verificationCode)
      .digest("hex");

    if (hashedCode !== user.verificationCode) {
      return res.status(400).json({ message: "Invalid verification code" });
    }

    // ✅ تفعيل الحساب
    user.isVerified = true;
    user.verificationCode = undefined;
    user.verificationExpires = undefined;
    await user.save();

    await Dashboard.create({
      userId: user._id,
      availablePoints: 100,
      recentActivity: ["Welcome to Dalily.ai! Your account is now active."],
    });

    const token = createToken(user._id, user.isAdmin, user.isSuperAdmin);

    res.json({
      success: true,
      message: "Account verified successfully",
      user: createUserResponse(user),
      token,
    });
  } catch (err) {
    console.error("Verify signup error:", err);
    res.status(500).json({ message: "Verification failed" });
  }
});

// =========================
// Email/Password Login
// =========================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Input validation
    if (!email || !password) {
      return res.status(400).json({
        message: "Please provide email and password",
      });
    }

    // Find user
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Check if user has a password (might be Google-only user)
    if (!user.password) {
      return res.status(400).json({
        message: "Please login with Google or reset your password",
      });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Ensure user has a dashboard
    let dashboard = await Dashboard.findOne({ userId: user._id });
    if (!dashboard) {
      dashboard = await Dashboard.create({
        userId: user._id,
        availablePoints: 100,
        recentActivity: [`Welcome back! Dashboard created.`],
      });
    }

    const token = createToken(user._id, user.isAdmin, user.isSuperAdmin);

    res.json({
      success: true,
      message: "Login successful",
      user: createUserResponse(user),
      token,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      message: "Server error during login",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// =========================
// forgot-password-and-send-Email
// =========================
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Security: don't reveal if email exists
      return res.json({
        message:
          "If an account with that email exists, a reset link has been sent.",
      });
    }

    // Generate secure reset token
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedResetCode = crypto
      .createHash("sha256")
      .update(resetCode)
      .digest("hex");

    // Save hashed code and expiry to DB
    user.resetPasswordCode = hashedResetCode;
    user.resetPasswordExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
    user.resetPasswordVerified = false;

    await user.save();

    try {
      await sendEmail({
        email: user.email,
        subject: "your pass reset code (valid for 10 mins)",
        text: `Hi ${user.name},\nYou requested to reset your password for Dalily.ai.\nYour 6-digit verification code is: ${resetCode}\nThis code expires in 10 minutes.\nIf you didn't request this, please ignore this email.\n— The Dalily.ai Team`,
      });
    } catch (err) {
      user.resetPasswordCode = undefined;
      user.resetPasswordExpires = undefined;
      user.resetPasswordVerified = undefined;
      await user.save();
      return res.status(500).json({
        message: `${err.message}`,
      });
    }

    res.status(200).json({
      message:
        "If an account with that email exists, a reset code has been sent.",
    });
  } catch (err) {
    console.error("Password reset error:", err);
    res.status(500).json({ message: "Failed to send reset email" });
  }
});

// =========================
// verify-code-and-reset-password
// =========================
router.post("/reset-password", async (req, res) => {
  try {
    const { resetCode, newPassword } = req.body;

    if (!resetCode || !newPassword) {
      return res
        .status(400)
        .json({ message: "Reset code and new password are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters",
      });
    }

    const hashedCode = crypto
      .createHash("sha256")
      .update(resetCode)
      .digest("hex");

    const user = await User.findOne({
      resetPasswordCode: hashedCode,
      resetPasswordExpires: { $gt: Date.now() },
      resetPasswordVerified: false,
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset code" });
    }

    // Update password and mark as verified
    user.password = await bcrypt.hash(newPassword, 12);
    user.resetPasswordCode = undefined;
    user.resetPasswordExpires = undefined;
    user.resetPasswordVerified = undefined;
    await user.save();

    res.json({ message: "Password has been reset successfully" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// Google Auth Routes
// =========================
router.get("/google", (req, res, next) => {
  console.log("Google auth initiated");
  passport.authenticate("google", {
    session: false,
    scope: ["profile", "email"],
    prompt: "select_account",
  })(req, res, next);
});

router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: getRedirectURL("/"),
  }),
  (req, res) => {
    const { token, user } = req.user;

    if (!token || !user) {
      console.error("Google auth failed: missing token or user");
      return res.redirect(getRedirectURL("/"));
    }

    // تأكد أن الداشبورد موجود
    Dashboard.findOne({ userId: user._id }).then((dashboard) => {
      if (!dashboard) {
        Dashboard.create({
          userId: user._id,
          availablePoints: 100,
          recentActivity: ["Welcome! Signed up with Google."],
        }).catch((err) => {
          console.error("Failed to create dashboard:", err);
        });
      }
    });

    // ريدايركت مع التوكن
    const redirectURL = getRedirectURL(`/google-success?token=${token}`);
    res.redirect(redirectURL);
  },
);

// =========================
// Auth Middleware
// =========================
const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res
        .status(401)
        .json({ message: "No authorization header provided" });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    req.isAdmin = decoded.isAdmin;
    req.isSuperAdmin = decoded.isSuperAdmin;

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token" });
    }
    res.status(401).json({ message: "Token verification failed" });
  }
};

// =========================
// Get Current User
// =========================
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res
        .status(401)
        .json({ message: "No authorization header provided" });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    console.log("User fetched from DB:", user?.email);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      success: true,
      user: createUserResponse(user),
    });
  } catch (err) {
    console.error("Get current user error:", err);
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token" });
    }
    res.status(401).json({ message: "Token verification failed" });
  }
});

// =========================
// Logout (Optional - for session cleanup)
// =========================
router.post("/logout", authMiddleware, (req, res) => {
  try {
    req.logout((err) => {
      if (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ message: "Error during logout" });
      }

      console.log(`User logged out: ${req.userId}`);
      res.json({
        success: true,
        message: "Logged out successfully",
      });
    });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ message: "Server error during logout" });
  }
});

// =========================
// Token Refresh (Optional)
// =========================
router.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token required" });
    }

    const decoded = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    );
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const newToken = createToken(user._id, user.isAdmin, user.isSuperAdmin);

    res.json({
      success: true,
      token: newToken,
      user: createUserResponse(user),
    });
  } catch (err) {
    console.error("Token refresh error:", err);
    res.status(401).json({ message: "Invalid refresh token" });
  }
});

// =========================
// Auth Status Check
// =========================
router.get("/status", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const dashboard = await Dashboard.findOne({ userId: req.userId });

    res.json({
      success: true,
      authenticated: true,
      user: createUserResponse(user),
      dashboard: {
        availablePoints: dashboard?.availablePoints || 0,
        totalContacts: dashboard?.totalContacts || 0,
        unlockedProfiles: dashboard?.unlockedProfiles || 0,
        uploadedProfiles: dashboard?.uploadedProfiles || 0,
      },
    });
  } catch (err) {
    console.error("Auth status error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Export middleware for use in other routes
module.exports = router;
module.exports.authMiddleware = authMiddleware;
