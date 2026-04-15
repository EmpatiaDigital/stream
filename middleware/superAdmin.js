export const superAdminOnly = (req, res, next) => {
  if (req.user?.role !== "superadmin") {
    return res.status(403).json({ msg: "Acceso denegado" });
  }
  next();
};