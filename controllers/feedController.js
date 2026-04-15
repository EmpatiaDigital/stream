// controllers/feedController.js
import Post from "../models/postModel.js";

export const getFeed = async (req, res) => {
  try {
    const { category, page = 1, limit = 12, sort = "trending" } = req.query;

    const filter = { type: "video" };
    if (category && category !== "Todo") {
      filter.category = category;
    }

    let sortQuery = {};
    switch (sort) {
      case "trending":
        return res.json(await getTrending(filter, Number(page), Number(limit)));
      case "nuevo":
        sortQuery = { createdAt: -1 };
        break;
      case "popular":
        sortQuery = { views: -1 };
        break;
      default:
        sortQuery = { createdAt: -1 };
    }

    const total = await Post.countDocuments(filter);
    const posts = await Post.find(filter)
      .sort(sortQuery)
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate("user", "name username avatar")
      .lean();

    res.json({ posts, total, pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error("getFeed error:", err); // ← add this for future debugging
    res.status(500).json({ error: err.message });
  }
};

async function getTrending(filter, page, limit) {
  const posts = await Post.aggregate([
    { $match: filter },
    {
      $addFields: {
        // ↓ Guard against null/missing likes and viewsLastDay
        _likesCount: {
          $size: { $ifNull: ["$likes", []] },
        },
        _viewsLastDay: { $ifNull: ["$viewsLastDay", 0] },
      },
    },
    {
      $addFields: {
        score: {
          $add: [
            { $multiply: ["$_likesCount", 2] },
            "$_viewsLastDay",
            {
              $cond: {
                if: {
                  $gte: [
                    "$createdAt",
                    { $subtract: [new Date(), 48 * 60 * 60 * 1000] },
                  ],
                },
                then: 10,
                else: 0,
              },
            },
          ],
        },
      },
    },
    { $sort: { score: -1, createdAt: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: limit },
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "user",
        pipeline: [{ $project: { name: 1, username: 1, avatar: 1 } }],
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
  ]);

  const total = await Post.countDocuments(filter);
  return { posts, total, pages: Math.ceil(total / limit) };
}

export const incrementView = async (req, res) => {
  try {
    await Post.findByIdAndUpdate(req.params.postId, {
      $inc: { views: 1, viewsLastDay: 1 },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const resetDailyViews = async () => {
  await Post.updateMany({}, { $set: { viewsLastDay: 0 } });
  console.log("✅ viewsLastDay reseteado");
};