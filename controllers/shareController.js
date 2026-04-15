import Post from "../models/postModel.js";

const FRONT_URL = process.env.FRONT_URL || "http://localhost:3000";

// GET /api/share/:postId
// Devuelve HTML con Open Graph tags y redirige al front
export const getSharePage = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId)
      .populate("user", "name username avatar")
      .lean();

    if (!post) return res.status(404).send("Video no encontrado");

    const title       = post.title       || "Video en TuPlataforma";
    const description = post.description || `${post.user?.name} compartió un video`;
    const image       = post.thumbnail   || `${FRONT_URL}/images/preview.png`;
    const videoUrl    = `${FRONT_URL}/ver/${post._id}`;
    const shareUrl    = `${process.env.BACK_URL || "http://localhost:4000"}/api/share/${post._id}`;

    // HTML mínimo con OG tags + redirect automático
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0; url=${videoUrl}" />

  <!-- Open Graph -->
  <meta property="og:type"        content="video.other" />
  <meta property="og:url"         content="${shareUrl}" />
  <meta property="og:title"       content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image"       content="${image}" />
  <meta property="og:image:width" content="1280" />
  <meta property="og:image:height"content="720" />

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image" />
  <meta name="twitter:title"       content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image"       content="${image}" />

  <!-- WhatsApp / general -->
  <meta name="description" content="${description}" />

  <title>${title}</title>
</head>
<body style="background:#0d0d1a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <p>Redirigiendo al video…</p>
  <script>window.location.href = "${videoUrl}";</script>
</body>
</html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/share/post/:postId  → JSON puro para el front
export const getPostById = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId)
      .populate("user", "name username avatar")
      .lean();

    if (!post) return res.status(404).json({ error: "No encontrado" });

    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};