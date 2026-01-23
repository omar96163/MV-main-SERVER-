const express = require("express");
const Profile = require("../models/profile.js");
const Dashboard = require("../models/Dashboard");

const router = express.Router();

// GET all profiles - now includes user-specific unlock status
router.get("/", async (req, res) => {
  try {
    const { userId } = req.query;

    const profiles = await Profile.find().sort({ createdAt: -1 });

    // If userId is provided, get their unlocked contacts
    let userUnlockedIds = [];
    if (userId) {
      const userDashboard = await Dashboard.findOne({ userId });
      userUnlockedIds = userDashboard?.unlockedProfileIds || [];
    }

    res.json(
      profiles.map((p) => ({
        ...p.toObject(),
        id: p._id.toString(),
        // Set isUnlocked based on current user's unlocked list
        isUnlocked: userUnlockedIds.includes(p._id.toString()),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all profiles for one user
router.get("/mine", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    // 1. جيب الداشبورد بتاع المستخدم
    const dashboard = await Dashboard.findOne({ userId });

    if (!dashboard) {
      return res.status(404).json({ error: "User dashboard not found" });
    }

    // 2. IDs البروفايلات اللي رفعها + اللي فتحها
    const relevantIds = [
      ...new Set([
        ...dashboard.uploadedProfileIds,
        ...dashboard.unlockedProfileIds,
      ]),
    ];

    if (relevantIds.length === 0) {
      return res.json([]);
    }

    // 3. جيب البروفايلات دي من قاعدة البيانات
    const profiles = await Profile.find({
      _id: { $in: relevantIds },
    }).sort({ uploadedAt: -1 });

    // 4. رتب النتيجة علشان تظهر الـ uploaded أولًا
    const uploadedSet = new Set(dashboard.uploadedProfileIds);
    const sortedProfiles = profiles.sort((a, b) => {
      const aIsUploaded = uploadedSet.has(a._id.toString());
      const bIsUploaded = uploadedSet.has(b._id.toString());

      if (aIsUploaded && !bIsUploaded) return -1;
      if (!aIsUploaded && bIsUploaded) return 1;
      return 0;
    });

    res.json(
      sortedProfiles.map((p) => ({
        ...p.toObject(),
        id: p._id.toString(),
        isUnlocked: true, // كلهم مفتوحين أو مرفوعين
        isOwnUpload: uploadedSet.has(p._id.toString()),
      }))
    );
  } catch (err) {
    console.error("Error fetching user profiles:", err);
    res.status(500).json({ error: "Failed to fetch profiles" });
  }
});

// GET single profile by ID - with user-specific unlock status
router.get("/:id", async (req, res) => {
  try {
    const { userId } = req.query;

    const profile = await Profile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Check if this user has unlocked this profile
    let isUnlocked = false;
    if (userId) {
      const userDashboard = await Dashboard.findOne({ userId });
      isUnlocked =
        userDashboard?.unlockedProfileIds.includes(req.params.id) || false;
    }

    res.json({
      ...profile.toObject(),
      id: profile._id.toString(),
      isUnlocked,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST unlock profile (deduct points and add to user's unlocked list)
router.post("/:id/unlock", async (req, res) => {
  try {
    const { userId } = req.body;
    const profileId = req.params.id;

    // Check if profile exists
    const profile = await Profile.findById(profileId);
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    // Get user's dashboard
    const dashboard = await Dashboard.findOne({ userId });
    if (!dashboard) {
      return res.status(404).json({ error: "Dashboard not found" });
    }

    // Check if user already unlocked this profile
    if (dashboard.unlockedProfileIds.includes(profileId)) {
      return res
        .status(400)
        .json({ error: "Profile already unlocked by this user" });
    }

    // Check if user has enough points
    if (dashboard.availablePoints < 20) {
      return res.status(400).json({
        error: "Insufficient points",
        required: 20,
        available: dashboard.availablePoints,
      });
    }

    // Update dashboard: deduct points, increment unlocked profiles, add to unlocked list, add activity
    await Dashboard.findOneAndUpdate(
      { userId },
      {
        $inc: {
          availablePoints: -20,
          totalContacts: 1,
          unlockedProfiles: 1,
        },
        $push: {
          unlockedProfileIds: profileId, // Add to user's unlocked list
          recentActivity: {
            $each: [`Unlocked LinkedIn profile: ${profile.name || "Unknown"}`],
            $slice: -10, // Keep only last 10 activities
          },
        },
        updatedAt: new Date(),
      }
    );

    // Get updated dashboard
    const updatedDashboard = await Dashboard.findOne({ userId });

    res.json({
      success: true,
      profile: {
        ...profile.toObject(),
        id: profile._id.toString(),
        isUnlocked: true, // For this user, it's now unlocked
      },
      dashboard: updatedDashboard,
      pointsDeducted: 20,
      remainingPoints: updatedDashboard.availablePoints,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST new profile with dashboard update
router.post("/", async (req, res) => {
  try {
    const profile = await Profile.create(req.body);

    // Update dashboard for the user who uploaded
    if (req.body.uploadedBy) {
      await Dashboard.findOneAndUpdate(
        { userId: req.body.uploadedBy },
        {
          $inc: {
            availablePoints: 10,
            totalContacts: 1,
            uploadedProfiles: 1,
          },
          $push: {
            uploadedProfileIds: profile._id.toString(),
            recentActivity: {
              $each: [`Uploaded contact: ${req.body.name || "Unknown"}`],
              $slice: -10,
            },
          },
          updatedAt: new Date(),
        },
        { upsert: true }
      );
    }

    res.json({
      ...profile.toObject(),
      id: profile._id.toString(),
      isUnlocked: false,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST bulk profiles with dashboard update
router.post("/bulk", async (req, res) => {
  try {
    const { profiles, uploadedBy } = req.body;

    if (!profiles || !Array.isArray(profiles)) {
      return res.status(400).json({ error: "Invalid profiles data" });
    }

    // Create all profiles (no global isUnlocked field)
    const createdProfiles = await Profile.insertMany(profiles);

    // Update dashboard for bulk upload
    if (uploadedBy) {
      const pointsToAdd = createdProfiles.length * 10;
      const profileIds = createdProfiles.map((p) => p._id.toString());
      const activityMessages = createdProfiles.map(
        (p) => `Uploaded contact: ${p.name || "Unknown"}`
      );

      await Dashboard.findOneAndUpdate(
        { userId: uploadedBy },
        {
          $inc: {
            availablePoints: pointsToAdd,
            totalContacts: createdProfiles.length,
            uploadedProfiles: createdProfiles.length,
          },
          $push: {
            uploadedProfileIds: { $each: profileIds },
            recentActivity: {
              $each: activityMessages,
              $slice: -10,
            },
          },
          updatedAt: new Date(),
        },
        { upsert: true }
      );
    }

    res.json({
      success: true,
      count: createdProfiles.length,
      profiles: createdProfiles.map((p) => ({
        ...p.toObject(),
        id: p._id.toString(),
        isUnlocked: false, // Default for new profiles
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
