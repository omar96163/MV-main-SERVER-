const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Dashboard = require("../models/Dashboard");
const bcrypt = require("bcryptjs");

const router = express.Router();

// Helper function to get redirect URLs
const getRedirectURL = (path) => {
  const baseURL = process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL 
    : 'https://contactpro-hrmanager.vercel.app';
  return `${baseURL}${path}`;
};

// Helper function to create JWT token
const createToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { 
    expiresIn: process.env.JWT_EXPIRES_IN || "7d" 
  });
};

// Helper function to create user response object
const createUserResponse = (user) => {
  return {
    id: user._id || user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar || null,
    googleId: user.googleId || null
  };
};

// =========================
// Email/Password Signup
// =========================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Input validation
    if (!name || !email || !password) {
      return res.status(400).json({ 
        message: "Please provide name, email, and password" 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        message: "Password must be at least 6 characters long" 
      });
    }

    // Check if user already exists
    let existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists with this email" });
    }

    // Hash password
    const saltRounds = process.env.NODE_ENV === 'production' ? 12 : 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user
    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword
    });

    // Create dashboard for new user (defaults handled in model)
    await Dashboard.create({ 
      userId: user._id,
      availablePoints: 100,
      totalContacts: 0,
      unlockedProfiles: 0,
      myUploads: 0,
      uploadedProfileIds: [],
      unlockedContactIds: [],
      recentActivity: [`Welcome to the platform! You started with 100 points.`]
    });

    // Create token
    const token = createToken(user._id);

    console.log(`New user registered: ${user.email}`);

    res.status(201).json({ 
      success: true,
      message: "Account created successfully",
      user: createUserResponse(user), 
      token 
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ 
      message: "Server error during registration",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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
        message: "Please provide email and password" 
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
        message: "Please login with Google or reset your password" 
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
        recentActivity: [`Welcome back! Dashboard created.`]
      });
    }

    const token = createToken(user._id);

    console.log(`User logged in: ${user.email}`);

    res.json({ 
      success: true,
      message: "Login successful",
      user: createUserResponse(user), 
      token 
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ 
      message: "Server error during login",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// =========================
// Google Auth Routes
// =========================
router.get("/google", (req, res, next) => {
  console.log("Google auth initiated");
  passport.authenticate("google", { 
    scope: ["profile", "email"],
    prompt: "select_account" // Allow users to choose account
  })(req, res, next);
});

router.get(
  "/google/callback",
  passport.authenticate("google", { 
    failureRedirect: getRedirectURL('/login?error=google_auth_failed'),
    session: true
  }),
  async (req, res) => {
    try {
      console.log("Google callback received for user:", req.user?.email);

      if (!req.user) {
        console.error("No user in Google callback");
        return res.redirect(getRedirectURL('/login?error=no_user_data'));
      }

      // Ensure user has a dashboard
      let dashboard = await Dashboard.findOne({ userId: req.user._id });
      if (!dashboard) {
        dashboard = await Dashboard.create({ 
          userId: req.user._id,
          availablePoints: 100,
          recentActivity: [`Welcome! Signed up with Google.`]
        });
        console.log(`Dashboard created for Google user: ${req.user.email}`);
      }

      const token = createToken(req.user._id);

      // Redirect with token
      const redirectURL = getRedirectURL(`/google-success?token=${token}`);
      console.log(`Redirecting to: ${redirectURL}`);
      
      res.redirect(redirectURL);
    } catch (err) {
      console.error("Google callback error:", err);
      res.redirect(getRedirectURL('/login?error=dashboard_creation_failed'));
    }
  }
);

// =========================
// Password Reset (Optional)
// =========================
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Don't reveal if email exists for security
      return res.json({ 
        message: "If an account with that email exists, a reset link has been sent." 
      });
    }

    // TODO: Implement email sending logic here
    // For now, just return success message
    console.log(`Password reset requested for: ${email}`);

    res.json({ 
      message: "If an account with that email exists, a reset link has been sent." 
    });
  } catch (err) {
    console.error("Password reset error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// Auth Middleware
// =========================
const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({ message: "No authorization header provided" });
    }

    const token = authHeader.split(" ")[1];
    
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: "Token expired" });
    }
    if (err.name === 'JsonWebTokenError') {
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
      return res.status(401).json({ message: "No authorization header provided" });
    }

    const token = authHeader.split(" ")[1];
    
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");
    
    console.log('User fetched from DB:', user?.email); 
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    res.json({
      success: true,
      user: createUserResponse(user)
    });
  } catch (err) {
    console.error("Get current user error:", err);
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: "Token expired" });
    }
    if (err.name === 'JsonWebTokenError') {
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
        message: "Logged out successfully" 
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

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const newToken = createToken(user._id);
    
    res.json({ 
      success: true,
      token: newToken,
      user: createUserResponse(user)
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
        myUploads: dashboard?.myUploads || 0
      }
    });
  } catch (err) {
    console.error("Auth status error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Export middleware for use in other routes
module.exports = router;
module.exports.authMiddleware = authMiddleware;