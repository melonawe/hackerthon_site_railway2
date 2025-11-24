// server.js - Railway 배포용 Node + Express + MySQL + 이미지업로드 + 번역 + 좋아요 + 질문게시판

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
require("dotenv").config();

// node-fetch v3 ESM 호환용 래퍼
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------
// MySQL 연결 풀
// ----------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST,      // Railway Variables 에서 설정
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ----------------------
// 미들웨어
// ----------------------
app.use(
  cors({
    origin: "*", // 나중에 배포 도메인으로 제한해도 됨
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 정적 파일 (프론트엔드)
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// ----------------------
// 업로드 폴더 + multer 설정
// ----------------------
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, base + "-" + unique + ext);
  },
});

const upload = multer({ storage });

// 업로드된 파일은 /uploads 경로로 공개
app.use("/uploads", express.static(uploadDir));

// ----------------------
// 홈 -> sample.html
// ----------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "sample.html"));
});

// =====================================================
// 이미지 업로드 API
// =====================================================
app.post("/api/upload-image", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "이미지 파일이 없습니다." });
    }
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, image_url: imageUrl });
  } catch (err) {
    console.error("POST /api/upload-image error:", err);
    res
      .status(500)
      .json({ error: "이미지 업로드 중 서버 에러가 발생했습니다." });
  }
});

// =====================================================
// 장소 공유: 목록 조회
// GET /api/places
// =====================================================
app.get("/api/places", async (req, res) => {
  try {
    const conn = await pool.getConnection();

    const [rows] = await conn.query(
      `
      SELECT
        p.id,
        p.title,
        p.description,
        p.lat,
        p.lng,
        p.tags,
        p.image_url,
        p.created_at,
        COUNT(DISTINCT pl.ip) AS like_count
      FROM places p
      LEFT JOIN place_likes pl
        ON p.id = pl.place_id
      GROUP BY p.id
      ORDER BY p.id DESC
      `
    );

    conn.release();

    const places = rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      lat: r.lat,
      lng: r.lng,
      tags: r.tags
        ? r.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      image_url: r.image_url,
      created_at: r.created_at,
      like_count: r.like_count || 0,
    }));

    res.json(places);
  } catch (err) {
    console.error("GET /api/places error:", err);
    res
      .status(500)
      .json({ error: "장소 목록을 불러오는 중 서버 에러가 발생했습니다." });
  }
});

// =====================================================
// 장소 공유: 새 장소 등록
// POST /api/places
// body: { title, description, tags[], lat, lng, image_url }
// =====================================================
app.post("/api/places", async (req, res) => {
  try {
    const { title, description, tags, lat, lng, image_url } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title은 필수입니다." });
    }

    const tagsStr = Array.isArray(tags)
      ? tags
          .map((t) => String(t).trim())
          .filter(Boolean)
          .join(",")
      : (tags || "").trim() || null;

    const conn = await pool.getConnection();

    await conn.query(
      `
      INSERT INTO places (title, description, lat, lng, tags, image_url)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        title.trim(),
        description || "",
        lat || null,
        lng || null,
        tagsStr,
        image_url || null,
      ]
    );

    conn.release();

    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/places error:", err);
    res
      .status(500)
      .json({ error: "장소를 저장하는 중 서버 에러가 발생했습니다." });
  }
});

// =====================================================
// 좋아요: IP당 1회 제한
// POST /api/places/:id/like
// =====================================================
app.post("/api/places/:id/like", async (req, res) => {
  const placeId = parseInt(req.params.id, 10);
  if (!placeId) {
    return res.status(400).json({ error: "잘못된 place id입니다." });
  }

  // 프록시 환경 고려: x-forwarded-for 우선 사용
  const ip =
    (req.headers["x-forwarded-for"] &&
      req.headers["x-forwarded-for"].split(",")[0].trim()) ||
    req.socket.remoteAddress ||
    "0.0.0.0";

  try {
    const conn = await pool.getConnection();

    try {
      await conn.query(
        `
        INSERT INTO place_likes (place_id, ip)
        VALUES (?, ?)
        `,
        [placeId, ip]
      );
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") {
        conn.release();
        return res
          .status(400)
          .json({ error: "이미 이 장소에 좋아요를 누르셨습니다." });
      }
      throw err;
    }

    const [rows] = await conn.query(
      `
      SELECT COUNT(DISTINCT ip) AS like_count
      FROM place_likes
      WHERE place_id = ?
      `,
      [placeId]
    );
    conn.release();

    const likeCount = rows[0]?.like_count || 0;
    res.json({ success: true, like_count: likeCount });
  } catch (err) {
    console.error("POST /api/places/:id/like error:", err);
    res
      .status(500)
      .json({ error: "좋아요 처리 중 서버 에러가 발생했습니다." });
  }
});

// =====================================================
// 번역 API 프록시 (/translate)
// DEEPL_API_KEY 없으면 원문 그대로 반환
// =====================================================
app.post("/translate", async (req, res) => {
  const { text, target_lang } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ error: "번역할 text가 없습니다." });
  }

  // 번역 API 키 없으면 그대로 반환
  if (!process.env.DEEPL_API_KEY) {
    return res.json({
      translations: [{ text }],
    });
  }

  try {
    const resp = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
      },
      body: new URLSearchParams({
        text,
        target_lang: target_lang || "JA",
      }),
    });

    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error("POST /translate error:", err);
    res.status(500).json({ error: "번역 중 서버 에러가 발생했습니다." });
  }
});

// =====================================================
// 질문 게시판 (최소 구현)
// GET /api/questions
// =====================================================
app.get("/api/questions", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.query(
      `
      SELECT
        q.id,
        q.content,
        q.created_at
      FROM questions q
      ORDER BY q.id DESC
      `
    );
    conn.release();

    const questions = rows.map((r) => ({
      id: r.id,
      content: r.content,
      created_at: r.created_at,
    }));

    res.json(questions);
  } catch (err) {
    console.error("GET /api/questions error:", err);
    res
      .status(500)
      .json({ error: "질문 목록을 불러오는 중 서버 에러가 발생했습니다." });
  }
});

// =====================================================
// 서버 시작
// =====================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
