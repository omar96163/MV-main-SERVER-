const express = require("express");
const Dashboard = require("../models/Dashboard");
const Profile = require("../models/profile");
const { authMiddleware } = require("./auth");

const router = express.Router();

// GET dashboard with calculated stats - NOW PROTECTED
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    let dashboard = await Dashboard.findOne({ userId });

    // If no dashboard exists, create one with defaults
    if (!dashboard) {
      dashboard = await Dashboard.create({
        userId,
        availablePoints: 100,
        totalContacts: 0,
        unlockedProfiles: 0,
        uploadedProfiles: 0,
        uploadedProfileIds: [],
        unlockedProfileIds: [],
        recentActivity: ["Welcome! Dashboard created."],
      });
    }

    // Calculate actual stats from database to ensure accuracy
    const actualUploads = (await dashboard.uploadedProfileIds)
      ? dashboard.uploadedProfileIds.length
      : 0;
    const actualUnlockedCount = dashboard.unlockedProfileIds
      ? dashboard.unlockedProfileIds.length
      : 0;

    // Update dashboard with accurate counts if they don't match
    if (
      dashboard.uploadedProfiles !== actualUploads ||
      dashboard.unlockedProfiles !== actualUnlockedCount
    ) {
      dashboard.uploadedProfiles = actualUploads;
      dashboard.unlockedProfiles = actualUnlockedCount;
      dashboard.totalContacts = actualUploads + actualUnlockedCount;
      await dashboard.save();
    }

    res.json(dashboard);
  } catch (err) {
    console.error("Dashboard fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE dashboard - NOW PROTECTED
router.post("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId; // Get from auth middleware

    const updateData = {
      availablePoints: req.body.availablePoints,
      totalContacts: req.body.totalContacts,
      unlockedProfiles: req.body.unlockedProfiles,
      uploadedProfiles: req.body.uploadedProfiles,
      unlockedProfileIds: req.body.unlockedProfileIds || [],
      uploadedProfileIds: req.body.uploadedProfileIds || [],
      recentActivity: req.body.recentActivity || [],
      updatedAt: new Date(),
    };

    // Remove undefined values
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    });

    const dashboard = await Dashboard.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true, upsert: true },
    );

    res.json(dashboard);
  } catch (err) {
    console.error("Dashboard update error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET user's unlocked contacts with detailed info - NOW PROTECTED
router.get("/unlocked", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const dashboard = await Dashboard.findOne({ userId });
    if (!dashboard) {
      return res.status(404).json({ error: "Dashboard not found" });
    }

    // Get detailed info about unlocked contacts
    const unlockedProfiles = await Profile.find({
      _id: { $in: dashboard.unlockedProfileIds || [] },
    }).select("name jobTitle company uploadedAt");

    res.json({
      userId,
      unlockedProfileIds: dashboard.unlockedProfileIds || [],
      totalUnlocked: dashboard.unlockedProfiles || 0,
      actualUnlockedCount: dashboard.unlockedProfileIds
        ? dashboard.unlockedProfileIds.length
        : 0,
      unlockedProfiles,
    });
  } catch (err) {
    console.error("Unlocked contacts fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET user's activity summary - NOW PROTECTED
router.get("/activity", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const dashboard = await Dashboard.findOne({ userId });
    if (!dashboard) {
      return res.status(404).json({ error: "Dashboard not found" });
    }

    // Get detailed activity information
    const uploadedProfiles = await Profile.find({
      uploadedBy: userId,
    })
      .sort({ uploadedAt: -1 })
      .limit(10)
      .select("name jobTitle company uploadedAt");

    const recentActivity = dashboard.recentActivity || [];

    res.json({
      recentActivity: recentActivity.slice(-10).reverse(),
      uploadedProfiles,
      totalActivities: recentActivity.length,
      lastUpdated: dashboard.updatedAt,
    });
  } catch (err) {
    console.error("Activity fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH - Add activity - NOW PROTECTED
router.patch("/activity", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { activity } = req.body;

    if (!activity) {
      return res.status(400).json({ error: "Activity message required" });
    }

    const dashboard = await Dashboard.findOneAndUpdate(
      { userId },
      {
        $push: {
          recentActivity: {
            $each: [activity],
            $slice: -20,
          },
        },
        $set: { updatedAt: new Date() },
      },
      { new: true, upsert: true },
    );

    res.json({
      success: true,
      activity: activity,
      totalActivities: dashboard.recentActivity.length,
    });
  } catch (err) {
    console.error("Add activity error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
