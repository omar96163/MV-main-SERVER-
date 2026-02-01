const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    name: String,
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    googleId: {
      type: String,
      index: true,
    },
    password: String,
    avatar: String,
    resetPasswordCode: String,
    resetPasswordExpires: Date,
    resetPasswordVerified: Boolean,
    isVerified: { type: Boolean, default: false },
    verificationCode: String,
    verificationExpires: Date,
    isAdmin: { type: Boolean, default: false },
    isSuperAdmin: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: "uploadedAt", updatedAt: "updatedAt" } },
);

UserSchema.pre("save", function (next) {
  if (this.email === "dalilyaiweb@gmail.com") {
    this.isAdmin = true;
    this.isSuperAdmin = true;
  } else {
    this.isSuperAdmin = false;
  }
  next();
});

module.exports = mongoose.model("User", UserSchema);
