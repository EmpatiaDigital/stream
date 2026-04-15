// utils/checkPlan.js
export const checkPlanExpiration = async (user) => {
  if (user.plan !== "free" && user.planExpiresAt) {
    if (new Date() > user.planExpiresAt) {
      user.plan = "free";
      user.planExpiresAt = null;
      await user.save();
    }
  }
};