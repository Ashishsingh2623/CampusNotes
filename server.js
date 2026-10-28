require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { pool, initDB } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET missing from environment variables.");
}

const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;
const B2_REGION = process.env.B2_REGION;
const B2_ENDPOINT = process.env.B2_ENDPOINT;
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY;

const b2Configured = Boolean(
  B2_BUCKET_NAME &&
  B2_REGION &&
  B2_ENDPOINT &&
  B2_KEY_ID &&
  B2_APPLICATION_KEY
);

const b2 = b2Configured
  ? new S3Client({
      region: B2_REGION,
      endpoint: B2_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APPLICATION_KEY
      }
    })
  : null;

if (!b2Configured) {
  console.warn(
    "Backblaze B2 environment variables are incomplete."
  );
}

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

const COURSES = ["Diploma", "BCA", "BBA", "B.Tech"];
const BRANCHES = ["CSE", "IT", "ECE", "EE", "ME", "CE", "Civil"];

function norm(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeCourse(value) {
  const course = norm(value);
  return course === "btech" || course === "b.tech"
    ? "b.tech"
    : course;
}

function normalizeBranch(value) {
  const branch = norm(value);

  return ["civil", "ce", "civil engineering"].includes(branch)
    ? "ce"
    : branch;
}

function normalizeSemester(value) {
  const match = String(value ?? "").match(/[1-8]/);
  return match ? match[0] : "";
}

function validCourseDetails(course, branch, semester) {
  const limits = {
    Diploma: 6,
    BCA: 6,
    BBA: 6,
    "B.Tech": 8
  };

  const sem = Number(normalizeSemester(semester));

  if (!COURSES.includes(course)) return false;

  if (!Number.isInteger(sem) || sem < 1 || sem > limits[course]) {
    return false;
  }

  if (course === "Diploma" || course === "B.Tech") {
    return BRANCHES.some(
      item => normalizeBranch(item) === normalizeBranch(branch)
    );
  }

  return !String(branch ?? "").trim();
}

function safeUser(user) {
  const { password, ...publicUser } = user;
  return publicUser;
}

async function readDB() {
  const [
    usersResult,
    notesResult,
    quizzesResult,
    resultsResult
  ] = await Promise.all([
    pool.query("SELECT * FROM users ORDER BY created_at DESC"),
    pool.query("SELECT id, data FROM notes"),
    pool.query("SELECT id, data FROM quizzes"),
    pool.query("SELECT id, data FROM quiz_results")
  ]);

  const users = usersResult.rows.map(row => ({
    id: row.id,
    name: row.name,
    email: row.email,
    password: row.password,
    role: row.role,
    course: row.course,
    branch: row.branch || "",
    semester: row.semester,
    createdAt: row.created_at
  }));

  return {
    users,
    notes: notesResult.rows.map(row => row.data),
    quizzes: quizzesResult.rows.map(row => row.data),
    quizResults: resultsResult.rows.map(row => row.data)
  };
}

async function writeDB(db) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const table of ["notes", "quizzes", "quiz_results"]) {
      await client.query(`DELETE FROM ${table}`);
    }

    for (const note of db.notes) {
      await client.query(
        "INSERT INTO notes (id, data) VALUES ($1, $2::jsonb)",
        [String(note.id), JSON.stringify(note)]
      );
    }

    for (const quiz of db.quizzes) {
      await client.query(
        "INSERT INTO quizzes (id, data) VALUES ($1, $2::jsonb)",
        [String(quiz.id), JSON.stringify(quiz)]
      );
    }

    for (const result of db.quizResults) {
      await client.query(
        "INSERT INTO quiz_results (id, data) VALUES ($1, $2::jsonb)",
        [String(result.id), JSON.stringify(result)]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function authenticate(req, res, next) {
  const authorization = req.headers.authorization || "";

  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) {
    return res.status(401).json({
      message: "Please log in first."
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [String(decoded.id)]
    );

    const row = result.rows[0];

    if (!row) {
      return res.status(401).json({
        message: "Account not found. Please log in again."
      });
    }

    if (norm(row.role) !== norm(decoded.role)) {
      return res.status(401).json({
        message: "Invalid login session."
      });
    }

    req.user = {
      id: row.id,
      name: row.name,
      email: row.email,
      password: row.password,
      role: row.role,
      course: row.course,
      branch: row.branch || "",
      semester: row.semester,
      createdAt: row.created_at
    };

    next();
  } catch (error) {
    return res.status(401).json({
      message: "Session expired. Please log in again."
    });
  }
}

function requireTeacher(req, res, next) {
  if (norm(req.user.role) !== "teacher") {
    return res.status(403).json({
      message: "Admin access required."
    });
  }

  next();
}

function requireStudent(req, res, next) {
  if (norm(req.user.role) !== "student") {
    return res.status(403).json({
      message: "Student access required."
    });
  }

  next();
}

function studentMatchesItem(item, user) {
  const course = normalizeCourse(user.course);

  if (normalizeCourse(item.course) !== course) return false;

  if (
    normalizeSemester(item.semester) !==
    normalizeSemester(user.semester)
  ) {
    return false;
  }

  if (course === "bca" || course === "bba") return true;

  return normalizeBranch(item.branch) === normalizeBranch(user.branch);
}

function publicQuiz(quiz, showAnswers = false) {
  return {
    ...quiz,
    questions: (quiz.questions || []).map(question => {
      const result = {
        id: question.id,
        text: question.text,
        options: question.options
      };

      if (showAnswers) {
        result.correctAnswer = question.correctAnswer;
      }

      return result;
    })
  };
}

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    if (
      file.mimetype !== "application/pdf" ||
      path.extname(file.originalname).toLowerCase() !== ".pdf"
    ) {
      return callback(new Error("Only PDF files are allowed."));
    }

    callback(null, true);
  }
});

async function uploadPdfToB2(file) {
  if (!b2Configured || !b2) {
    throw new Error(
      "Backblaze B2 is not configured. Check Render environment variables."
    );
  }

  const key =
    Date.now() + "-" +
    crypto.randomBytes(10).toString("hex") +
    ".pdf";

  await b2.send(
    new PutObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentLength: file.size,
      ContentType: "application/pdf"
    })
  );

  return key;
}

async function getNoteFileUrl(note) {
  if (note && (note.storageProvider === "b2" || note.b2Key)) {
    if (!b2Configured || !b2) {
      throw new Error(
        "Backblaze B2 is not configured. Check Render environment variables."
      );
    }

    const key = note.b2Key || note.fileName;

    return getSignedUrl(
      b2,
      new GetObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: key,
        ResponseContentType: "application/pdf",
        ResponseContentDisposition: "inline"
      }),
      { expiresIn: 3600 }
    );
  }

  // Compatibility for older notes stored on local disk.
  return note?.fileUrl || "";
}

async function removeNoteFile(noteOrFilename) {
  if (!noteOrFilename) return;

  if (typeof noteOrFilename === "object") {
    const note = noteOrFilename;

    if (note.storageProvider === "b2" || note.b2Key) {
      if (b2Configured && b2) {
        const key = note.b2Key || note.fileName;

        await b2.send(
          new DeleteObjectCommand({
            Bucket: B2_BUCKET_NAME,
            Key: key
          })
        );
      }

      return;
    }

    noteOrFilename = note.fileName;
  }

  const filePath = path.join(
    UPLOAD_DIR,
    path.basename(String(noteOrFilename))
  );

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* STUDENT REGISTRATION */
app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const email = norm(req.body.email);
    const password = String(req.body.password ?? "");
    const course = String(req.body.course ?? "").trim();
    let branch = String(req.body.branch ?? "").trim();
    const semester = req.body.semester;

    if (["BCA", "BBA"].includes(course)) branch = "";

    if (!name || !email || !password) {
      return res.status(400).json({
        message: "Name, email and password are required."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        message: "Enter a valid email address."
      });
    }

    if (!validCourseDetails(course, branch, semester)) {
      return res.status(400).json({
        message: "Please select a valid course, branch and semester."
      });
    }

    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      password: await bcrypt.hash(password, 10),
      role: "student",
      course,
      branch,
      semester: Number(normalizeSemester(semester))
    };

    const result = await pool.query(
      `INSERT INTO users
       (id, name, email, password, role, course, branch, semester)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, email, role, course, branch, semester, created_at`,
      [
        user.id, user.name, user.email, user.password, user.role,
        user.course, user.branch, user.semester
      ]
    );

    res.status(201).json({
      message: "Registration successful.",
      user: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: "This email is already registered."
      });
    }

    console.error("Registration error:", error.message);
    res.status(500).json({ message: "Registration failed." });
  }
});

/* STUDENT / ADMIN LOGIN */
app.post("/api/login", async (req, res) => {
  try {
    const email = norm(req.body.email);
    const password = String(req.body.password ?? "");
    const role = norm(req.body.role);

    if (!email || !password || !["student", "teacher"].includes(role)) {
      return res.status(400).json({
        message: "Email, password and role are required."
      });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email) = $1 AND LOWER(role) = $2",
      [email, role]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or role."
      });
    }

    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({
        message: "Incorrect password."
      });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful.",
      token,
      user: safeUser(user)
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(500).json({ message: "Login failed." });
  }
});

app.get("/api/me", authenticate, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

/* NOTES LIST */
app.get("/api/notes", authenticate, async (req, res) => {
  try {
    const db = await readDB();
    let notes = db.notes;

    if (norm(req.user.role) === "student") {
      notes = notes.filter(note => studentMatchesItem(note, req.user));
    } else if (norm(req.user.role) !== "teacher") {
      return res.status(403).json({ message: "Access denied." });
    }

    notes.sort(
      (a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0)
    );

    const notesWithUrls = await Promise.all(
      notes.map(async note => ({
        ...note,
        fileUrl: await getNoteFileUrl(note)
      }))
    );

    res.json({ notes: notesWithUrls });
  } catch (error) {
    console.error("Load notes error:", error.message);
    res.status(500).json({ message: "Unable to load notes." });
  }
});

/* NOTES UPLOAD — BACKBLAZE B2 */
app.post(
  "/api/notes",
  authenticate,
  requireTeacher,
  upload.single("file"),
  async (req, res) => {
    let uploadedB2Key = null;

    try {
      const title = String(req.body.title ?? "").trim();
      const subject = String(req.body.subject ?? "").trim();
      const course = String(req.body.course ?? "").trim();
      let branch = String(req.body.branch ?? "").trim();
      const semester = req.body.semester;
      const description = String(req.body.description ?? "").trim();

      if (["BCA", "BBA"].includes(course)) branch = "";

      if (!title || !subject || !req.file) {
        return res.status(400).json({
          message: "Title, subject and PDF file are required."
        });
      }

      if (!validCourseDetails(course, branch, semester)) {
        return res.status(400).json({
          message: "Invalid course, branch or semester."
        });
      }

      uploadedB2Key = await uploadPdfToB2(req.file);

      const note = {
        id: crypto.randomUUID(),
        title,
        subject,
        course,
        branch,
        semester: Number(normalizeSemester(semester)),
        description,
        fileName: uploadedB2Key,
        b2Key: uploadedB2Key,
        storageProvider: "b2",
        originalFileName: req.file.originalname,
        fileUrl: "",
        fileType: "application/pdf",
        uploadedBy: req.user.id,
        uploadedByName: req.user.name,
        uploadedAt: new Date().toISOString()
      };

      const db = await readDB();
      db.notes.push(note);
      await writeDB(db);

      note.fileUrl = await getNoteFileUrl(note);

      res.status(201).json({
        message: "Notes uploaded successfully.",
        note
      });
    } catch (error) {
      if (uploadedB2Key && b2Configured && b2) {
        try {
          await b2.send(
            new DeleteObjectCommand({
              Bucket: B2_BUCKET_NAME,
              Key: uploadedB2Key
            })
          );
        } catch (cleanupError) {
          console.error("B2 upload cleanup error:", cleanupError.message);
        }
      }

      console.error("Upload notes error:", error.message);

      res.status(500).json({
        message: "Notes upload failed. Check server logs and B2 settings."
      });
    }
  }
);

/* NOTES EDIT */
app.put(
  "/api/notes/:id",
  authenticate,
  requireTeacher,
  upload.single("file"),
  async (req, res) => {
    let uploadedB2Key = null;

    try {
      const db = await readDB();
      const note = db.notes.find(
        item => String(item.id) === String(req.params.id)
      );

      if (!note) {
        return res.status(404).json({ message: "Note not found." });
      }

      const title = String(req.body.title ?? note.title).trim();
      const subject = String(req.body.subject ?? note.subject).trim();
      const course = String(req.body.course ?? note.course).trim();
      let branch = String(req.body.branch ?? note.branch ?? "").trim();
      const semester = req.body.semester ?? note.semester;
      const description = String(
        req.body.description ?? note.description ?? ""
      ).trim();

      if (["BCA", "BBA"].includes(course)) branch = "";

      if (!title || !subject || !validCourseDetails(course, branch, semester)) {
        return res.status(400).json({
          message: "Check title, subject, course, branch and semester."
        });
      }

      const oldNoteFile = { ...note };

      Object.assign(note, {
        title,
        subject,
        course,
        branch,
        semester: Number(normalizeSemester(semester)),
        description,
        updatedAt: new Date().toISOString()
      });

      if (req.file) {
        uploadedB2Key = await uploadPdfToB2(req.file);

        note.fileName = uploadedB2Key;
        note.b2Key = uploadedB2Key;
        note.storageProvider = "b2";
        note.originalFileName = req.file.originalname;
        note.fileUrl = "";
        note.fileType = "application/pdf";
      }

      await writeDB(db);

      if (req.file) {
        try {
          await removeNoteFile(oldNoteFile);
        } catch (cleanupError) {
          console.error("Old note file cleanup error:", cleanupError.message);
        }
      }

      note.fileUrl = await getNoteFileUrl(note);

      res.json({
        message: "Note updated successfully.",
        note
      });
    } catch (error) {
      if (uploadedB2Key && b2Configured && b2) {
        try {
          await b2.send(
            new DeleteObjectCommand({
              Bucket: B2_BUCKET_NAME,
              Key: uploadedB2Key
            })
          );
        } catch (cleanupError) {
          console.error("B2 edit cleanup error:", cleanupError.message);
        }
      }

      console.error("Edit note error:", error.message);

      res.status(500).json({
        message: "Unable to update note. Check server logs and B2 settings."
      });
    }
  }
);

/* NOTES DELETE */
app.delete(
  "/api/notes/:id",
  authenticate,
  requireTeacher,
  async (req, res) => {
    try {
      const db = await readDB();

      const index = db.notes.findIndex(
        item => String(item.id) === String(req.params.id)
      );

      if (index === -1) {
        return res.status(404).json({ message: "Note not found." });
      }

      const [note] = db.notes.splice(index, 1);

      await writeDB(db);
      await removeNoteFile(note);

      res.json({ message: "Note deleted successfully." });
    } catch (error) {
      console.error("Delete note error:", error.message);
      res.status(500).json({ message: "Unable to delete note." });
    }
  }
);
/* CREATE QUIZ DRAFT */
app.post("/api/quizzes", authenticate, requireTeacher, async (req, res) => {
  try {
    const title = String(req.body.title ?? "").trim();
    const subject = String(req.body.subject ?? "").trim();
    const course = String(req.body.course ?? "").trim();
    let branch = String(req.body.branch ?? "").trim();
    const semester = req.body.semester;
    const rawQuestions = req.body.questions;

    if (["BCA", "BBA"].includes(course)) branch = "";

    if (!title || !subject) {
      return res.status(400).json({
        message: "Quiz title and subject are required."
      });
    }

    if (!validCourseDetails(course, branch, semester)) {
      return res.status(400).json({
        message: "Invalid course, branch or semester."
      });
    }

    if (
      !Array.isArray(rawQuestions) ||
      rawQuestions.length < 1 ||
      rawQuestions.length > 100
    ) {
      return res.status(400).json({
        message: "Add between 1 and 100 questions."
      });
    }

    const questions = [];

    for (let i = 0; i < rawQuestions.length; i++) {
      const question = rawQuestions[i] || {};
      const text = String(
        question.text ?? question.question ?? ""
      ).trim();

      const options = Array.isArray(question.options)
        ? question.options.map(value => String(value ?? "").trim())
        : [];

      const correctAnswer = Number(question.correctAnswer);

      if (
        !text ||
        options.length !== 4 ||
        options.some(value => !value)
      ) {
        return res.status(400).json({
          message: `Question ${i + 1}: provide a question and four options.`
        });
      }

      if (
        !Number.isInteger(correctAnswer) ||
        correctAnswer < 0 ||
        correctAnswer > 3
      ) {
        return res.status(400).json({
          message: `Question ${i + 1}: select the correct option.`
        });
      }

      questions.push({
        id: crypto.randomUUID(),
        text,
        options,
        correctAnswer
      });
    }

    const quiz = {
      id: crypto.randomUUID(),
      title,
      subject,
      course,
      branch,
      semester: Number(normalizeSemester(semester)),
      questions,
      published: false,
      createdBy: req.user.id,
      createdByName: req.user.name,
      createdAt: new Date().toISOString()
    };

    const db = await readDB();
    db.quizzes.push(quiz);
    await writeDB(db);

    res.status(201).json({
      message: "Quiz saved as draft. Publish it when ready.",
      quiz: publicQuiz(quiz, true)
    });
  } catch (error) {
    console.error("Create quiz error:", error.message);
    res.status(500).json({
      message: "Unable to create quiz."
    });
  }
});

/* PUBLISH QUIZ */
app.patch(
  "/api/quizzes/:id/publish",
  authenticate,
  requireTeacher,
  async (req, res) => {
    try {
      const db = await readDB();

      const quiz = db.quizzes.find(
        item => String(item.id) === String(req.params.id)
      );

      if (!quiz) {
        return res.status(404).json({
          message: "Quiz not found."
        });
      }

      if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
        return res.status(400).json({
          message: "Add at least one question before publishing."
        });
      }

      quiz.published = true;
      quiz.publishedAt = new Date().toISOString();

      await writeDB(db);

      res.json({
        message: "Quiz published successfully.",
        quiz: publicQuiz(quiz)
      });
    } catch (error) {
      console.error("Publish quiz error:", error.message);
      res.status(500).json({
        message: "Unable to publish quiz."
      });
    }
  }
);

/* LIST QUIZZES */
app.get("/api/quizzes", authenticate, async (req, res) => {
  try {
    const db = await readDB();
    let quizzes = db.quizzes;

    if (norm(req.user.role) === "student") {
      quizzes = quizzes.filter(
        quiz =>
          quiz.published !== false &&
          studentMatchesItem(quiz, req.user)
      );
    } else if (norm(req.user.role) !== "teacher") {
      return res.status(403).json({
        message: "Access denied."
      });
    }

    quizzes.sort(
      (a, b) =>
        new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    res.json({
      quizzes: quizzes.map(quiz => publicQuiz(quiz))
    });
  } catch (error) {
    console.error("Load quizzes error:", error.message);
    res.status(500).json({
      message: "Unable to load quizzes."
    });
  }
});

/* GET ONE QUIZ */
app.get("/api/quizzes/:id", authenticate, async (req, res) => {
  try {
    const db = await readDB();

    const quiz = db.quizzes.find(
      item => String(item.id) === String(req.params.id)
    );

    if (!quiz) {
      return res.status(404).json({
        message: "Quiz not found."
      });
    }

    if (!["student", "teacher"].includes(norm(req.user.role))) {
      return res.status(403).json({
        message: "Access denied."
      });
    }

    if (
      norm(req.user.role) === "student" &&
      quiz.published === false
    ) {
      return res.status(403).json({
        message: "This quiz has not been published yet."
      });
    }

    if (
      norm(req.user.role) === "student" &&
      !studentMatchesItem(quiz, req.user)
    ) {
      return res.status(403).json({
        message: "This quiz is not assigned to your course and semester."
      });
    }

    res.json({
      quiz: publicQuiz(quiz)
    });
  } catch (error) {
    console.error("Load quiz error:", error.message);
    res.status(500).json({
      message: "Unable to load quiz."
    });
  }
});

/* DELETE QUIZ */
app.delete(
  "/api/quizzes/:id",
  authenticate,
  requireTeacher,
  async (req, res) => {
    try {
      const db = await readDB();

      const index = db.quizzes.findIndex(
        item => String(item.id) === String(req.params.id)
      );

      if (index === -1) {
        return res.status(404).json({
          message: "Quiz not found."
        });
      }

      db.quizzes.splice(index, 1);

      db.quizResults = db.quizResults.filter(
        result => String(result.quizId) !== String(req.params.id)
      );

      await writeDB(db);

      res.json({
        message: "Quiz deleted successfully."
      });
    } catch (error) {
      console.error("Delete quiz error:", error.message);
      res.status(500).json({
        message: "Unable to delete quiz."
      });
    }
  }
);

/* SUBMIT QUIZ */
app.post(
  "/api/quizzes/:id/submit",
  authenticate,
  requireStudent,
  async (req, res) => {
    try {
      const db = await readDB();

      const quiz = db.quizzes.find(
        item => String(item.id) === String(req.params.id)
      );

      if (!quiz) {
        return res.status(404).json({
          message: "Quiz not found."
        });
      }

      if (quiz.published === false) {
        return res.status(403).json({
          message: "This quiz has not been published yet."
        });
      }

      if (!studentMatchesItem(quiz, req.user)) {
        return res.status(403).json({
          message: "This quiz is not assigned to your course and semester."
        });
      }

      const submittedAnswers = req.body.answers;

      if (
        !submittedAnswers ||
        typeof submittedAnswers !== "object" ||
        Array.isArray(submittedAnswers)
      ) {
        return res.status(400).json({
          message: "Please submit your answers."
        });
      }

      let score = 0;

      const answers = quiz.questions.map(question => {
        const rawAnswer = submittedAnswers[question.id];
        const selected = Number(rawAnswer);

        const valid =
          rawAnswer !== undefined &&
          rawAnswer !== null &&
          rawAnswer !== "" &&
          Number.isInteger(selected) &&
          selected >= 0 &&
          selected <= 3;

        const isCorrect =
          valid && selected === Number(question.correctAnswer);

        if (isCorrect) score++;

        return {
          questionId: question.id,
          selectedAnswer: valid ? selected : null,
          correctAnswer: Number(question.correctAnswer),
          isCorrect
        };
      });

      const result = {
        id: crypto.randomUUID(),
        quizId: quiz.id,
        quizTitle: quiz.title,
        subject: quiz.subject,
        studentId: req.user.id,
        studentName: req.user.name,
        course: req.user.course,
        branch: req.user.branch || "",
        semester: req.user.semester,
        totalQuestions: quiz.questions.length,
        score,
        percentage: Math.round(
          (score / quiz.questions.length) * 100
        ),
        answers,
        submittedAt: new Date().toISOString()
      };

      db.quizResults.push(result);
      await writeDB(db);

      res.status(201).json({
        message: "Quiz submitted successfully.",
        result
      });
    } catch (error) {
      console.error("Submit quiz error:", error.message);
      res.status(500).json({
        message: "Unable to submit quiz."
      });
    }
  }
);

/* QUIZ RESULT HISTORY */
app.get("/api/quiz-results", authenticate, async (req, res) => {
  try {
    const db = await readDB();
    let results = [];

    if (norm(req.user.role) === "student") {
      results = db.quizResults.filter(
        result => String(result.studentId) === String(req.user.id)
      );
    } else if (norm(req.user.role) === "teacher") {
      results = db.quizResults;

      if (req.query.quizId) {
        results = results.filter(
          result => String(result.quizId) === String(req.query.quizId)
        );
      }
    } else {
      return res.status(403).json({
        message: "Access denied."
      });
    }

    results.sort(
      (a, b) =>
        new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
    );

    res.json({ results });
  } catch (error) {
    console.error("Load quiz results error:", error.message);
    res.status(500).json({
      message: "Unable to load quiz results."
    });
  }
});

/* ADMIN DASHBOARD COUNTS */
app.get(
  "/api/admin/stats",
  authenticate,
  requireTeacher,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT course, branch, semester, COUNT(*)::int AS total
        FROM users
        WHERE role = 'student'
        GROUP BY course, branch, semester
        ORDER BY course, branch, semester
      `);

      const totalResult = await pool.query(
        "SELECT COUNT(*)::int AS total FROM users WHERE role = 'student'"
      );

      res.json({
        totalStudents: totalResult.rows[0].total,
        registrations: result.rows
      });
    } catch (error) {
      console.error("Admin stats error:", error.message);
      res.status(500).json({
        message: "Unable to load dashboard statistics."
      });
    }
  }
);

/* API 404 */
app.use("/api", (req, res) => {
  res.status(404).json({
    message: "API route not found."
  });
});

/* ERROR HANDLER */
app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "PDF must be 15 MB or smaller."
          : "File upload failed: " + error.message
    });
  }

  if (error.message === "Only PDF files are allowed.") {
    return res.status(400).json({
      message: error.message
    });
  }

  res.status(500).json({
    message: "Unexpected server error."
  });
});

/* START SERVER */
async function startServer() {
  try {
    await initDB();

    app.listen(PORT, () => {
      console.log("CampusNotes server started on port " + PORT);
      console.log("PostgreSQL connected.");
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();