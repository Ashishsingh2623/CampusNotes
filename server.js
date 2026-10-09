
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET =
  process.env.JWT_SECRET || "CampusNotes_Secure_Secret_2026";

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");

const COURSES = ["Diploma", "BCA", "BBA", "B.Tech"];
const BRANCHES = ["CSE", "IT", "ECE", "EE", "ME", "CE", "Civil"];

for (const dir of [PUBLIC_DIR, DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(
      { users: [], notes: [], quizzes: [], quizResults: [] },
      null,
      2
    )
  );
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

function norm(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeCourse(value) {
  const course = norm(value);
  if (course === "btech" || course === "b.tech") return "b.tech";
  return course;
}

function normalizeBranch(value) {
  const branch = norm(value);
  if (["civil", "ce", "civil engineering"].includes(branch)) {
    return "ce";
  }
  return branch;
}

function normalizeSemester(value) {
  const match = String(value ?? "").match(/[1-8]/);
  return match ? match[0] : "";
}

function readDB() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.notes)) db.notes = [];
  if (!Array.isArray(db.quizzes)) db.quizzes = [];
  if (!Array.isArray(db.quizResults)) db.quizResults = [];

  return db;
}

function writeDB(db) {
  const tempFile = DB_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
  fs.renameSync(tempFile, DB_FILE);
}

function validCourseDetails(course, branch, semester) {
  const selectedCourse = String(course ?? "").trim();
  const selectedSemester = Number(normalizeSemester(semester));

  const limits = {
    Diploma: 6,
    BCA: 6,
    BBA: 6,
    "B.Tech": 8
  };

  if (!COURSES.includes(selectedCourse)) return false;

  if (
    !Number.isInteger(selectedSemester) ||
    selectedSemester < 1 ||
    selectedSemester > limits[selectedCourse]
  ) {
    return false;
  }

  if (selectedCourse === "Diploma" || selectedCourse === "B.Tech") {
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

function authenticate(req, res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) {
    return res.status(401).json({ message: "Please log in first." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    const user = db.users.find(
      item => String(item.id) === String(decoded.id)
    );

    if (!user) {
      return res.status(401).json({
        message: "Account not found. Please log in again."
      });
    }

    if (norm(user.role) !== norm(decoded.role)) {
      return res.status(401).json({ message: "Invalid login session." });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({
      message: "Session expired. Please log in again."
    });
  }
}

function requireTeacher(req, res, next) {
  if (norm(req.user.role) !== "teacher") {
    return res.status(403).json({
      message: "Teacher access required."
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

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, UPLOAD_DIR);
  },
  filename: (req, file, callback) => {
    const filename =
      Date.now() +
      "-" +
      crypto.randomBytes(8).toString("hex") +
      ".pdf";

    callback(null, filename);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const isPdf =
      file.mimetype === "application/pdf" &&
      path.extname(file.originalname).toLowerCase() === ".pdf";

    if (!isPdf) {
      return callback(new Error("Only PDF files are allowed."));
    }

    callback(null, true);
  }
});

function removeUploadedFile(filename) {
  if (!filename) return;

  const safeName = path.basename(filename);
  const filePath = path.join(UPLOAD_DIR, safeName);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* =========================
   STUDENT REGISTRATION
========================= */

app.post("/api/register", async (req, res) => {
  try {
    const db = readDB();

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

    if (db.users.some(user => norm(user.email) === email)) {
      return res.status(409).json({
        message: "This email is already registered."
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
      semester: Number(normalizeSemester(semester)),
      createdAt: new Date().toISOString()
    };

    db.users.push(user);
    writeDB(db);

    res.status(201).json({
      message: "Registration successful.",
      user: safeUser(user)
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ message: "Registration failed." });
  }
});

/* =========================
   STUDENT / TEACHER LOGIN
========================= */

app.post("/api/login", async (req, res) => {
  try {
    const db = readDB();
    const email = norm(req.body.email);
    const password = String(req.body.password ?? "");
    const role = norm(req.body.role);

    if (!email || !password || !["student", "teacher"].includes(role)) {
      return res.status(400).json({
        message: "Email, password and role are required."
      });
    }

    const user = db.users.find(
      item => norm(item.email) === email && norm(item.role) === role
    );

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or role."
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.password
    );

    if (!passwordMatches) {
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
    console.error("Login error:", error);
    res.status(500).json({ message: "Login failed." });
  }
});

app.get("/api/me", authenticate, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

/* =========================
   NOTES: LIST
========================= */

app.get("/api/notes", authenticate, (req, res) => {
  try {
    const db = readDB();
    let notes = [...db.notes];

    if (norm(req.user.role) === "student") {
      notes = notes.filter(note => studentMatchesItem(note, req.user));
    } else if (norm(req.user.role) !== "teacher") {
      return res.status(403).json({ message: "Access denied." });
    }

    notes.sort(
      (a, b) =>
        new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0)
    );

    res.json({ notes });
  } catch (error) {
    console.error("Load notes error:", error);
    res.status(500).json({ message: "Unable to load notes." });
  }
});

/* =========================
   NOTES: UPLOAD PDF
========================= */

app.post(
  "/api/notes",
  authenticate,
  requireTeacher,
  upload.single("file"),
  (req, res) => {
    try {
      const db = readDB();

      const title = String(req.body.title ?? "").trim();
      const subject = String(req.body.subject ?? "").trim();
      const course = String(req.body.course ?? "").trim();
      let branch = String(req.body.branch ?? "").trim();
      const semester = req.body.semester;
      const description = String(req.body.description ?? "").trim();

      if (["BCA", "BBA"].includes(course)) branch = "";

      if (!title || !subject || !req.file) {
        removeUploadedFile(req.file?.filename);
        return res.status(400).json({
          message: "Title, subject and PDF file are required."
        });
      }

      if (!validCourseDetails(course, branch, semester)) {
        removeUploadedFile(req.file.filename);
        return res.status(400).json({
          message: "Invalid course, branch or semester."
        });
      }

      const note = {
        id: crypto.randomUUID(),
        title,
        subject,
        course,
        branch,
        semester: Number(normalizeSemester(semester)),
        description,
        fileName: req.file.filename,
        originalFileName: req.file.originalname,
        fileUrl: "/uploads/" + encodeURIComponent(req.file.filename),
        fileType: "application/pdf",
        uploadedBy: req.user.id,
        uploadedByName: req.user.name,
        uploadedAt: new Date().toISOString()
      };

      db.notes.push(note);
      writeDB(db);

      res.status(201).json({
        message: "Notes uploaded successfully.",
        note
      });
    } catch (error) {
      removeUploadedFile(req.file?.filename);
      console.error("Upload notes error:", error);
      res.status(500).json({ message: "Notes upload failed." });
    }
  }
);

/* =========================
   NOTES: EDIT
========================= */

app.put(
  "/api/notes/:id",
  authenticate,
  requireTeacher,
  upload.single("file"),
  (req, res) => {
    try {
      const db = readDB();
      const note = db.notes.find(
        item => String(item.id) === String(req.params.id)
      );

      if (!note) {
        removeUploadedFile(req.file?.filename);
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

      if (
        !title ||
        !subject ||
        !validCourseDetails(course, branch, semester)
      ) {
        removeUploadedFile(req.file?.filename);
        return res.status(400).json({
          message: "Check title, subject, course, branch and semester."
        });
      }

      const oldFilename = note.fileName;

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
        note.fileName = req.file.filename;
        note.originalFileName = req.file.originalname;
        note.fileUrl = "/uploads/" + encodeURIComponent(req.file.filename);
        note.fileType = "application/pdf";
      }

      writeDB(db);

      if (req.file && oldFilename) {
        removeUploadedFile(oldFilename);
      }

      res.json({
        message: "Note updated successfully.",
        note
      });
    } catch (error) {
      removeUploadedFile(req.file?.filename);
      console.error("Edit note error:", error);
      res.status(500).json({ message: "Unable to update note." });
    }
  }
);

/* =========================
   NOTES: DELETE
========================= */

app.delete(
  "/api/notes/:id",
  authenticate,
  requireTeacher,
  (req, res) => {
    try {
      const db = readDB();
      const index = db.notes.findIndex(
        item => String(item.id) === String(req.params.id)
      );

      if (index === -1) {
        return res.status(404).json({ message: "Note not found." });
      }

      const [note] = db.notes.splice(index, 1);
      writeDB(db);
      removeUploadedFile(note.fileName);

      res.json({ message: "Note deleted successfully." });
    } catch (error) {
      console.error("Delete note error:", error);
      res.status(500).json({ message: "Unable to delete note." });
    }
  }
);

/* =========================
   QUIZZES: CREATE DRAFT
========================= */

app.post("/api/quizzes", authenticate, requireTeacher, (req, res) => {
  try {
    const db = readDB();

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

    for (let index = 0; index < rawQuestions.length; index++) {
      const question = rawQuestions[index] || {};
      const text = String(
        question.text ?? question.question ?? ""
      ).trim();

      const options = Array.isArray(question.options)
        ? question.options.map(value => String(value ?? "").trim())
        : [];

      const correctAnswer = Number(question.correctAnswer);

      if (!text || options.length !== 4 || options.some(value => !value)) {
        return res.status(400).json({
          message: `Question ${index + 1}: provide a question and four options.`
        });
      }

      if (
        !Number.isInteger(correctAnswer) ||
        correctAnswer < 0 ||
        correctAnswer > 3
      ) {
        return res.status(400).json({
          message: `Question ${index + 1}: select the correct option.`
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

    db.quizzes.push(quiz);
    writeDB(db);

    res.status(201).json({
      message: "Quiz saved as draft. Publish it when ready.",
      quiz: publicQuiz(quiz, true)
    });
  } catch (error) {
    console.error("Create quiz error:", error);
    res.status(500).json({ message: "Unable to create quiz." });
  }
});

/* =========================
   QUIZZES: PUBLISH
========================= */

app.patch(
  "/api/quizzes/:id/publish",
  authenticate,
  requireTeacher,
  (req, res) => {
    try {
      const db = readDB();

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

      writeDB(db);

      res.json({
        message: "Quiz published successfully.",
        quiz: publicQuiz(quiz, false)
      });
    } catch (error) {
      console.error("Publish quiz error:", error);
      res.status(500).json({
        message: "Unable to publish quiz."
      });
    }
  }
);

/* =========================
   QUIZZES: LIST
========================= */

app.get("/api/quizzes", authenticate, (req, res) => {
  try {
    const db = readDB();
    let quizzes = [...db.quizzes];

    if (norm(req.user.role) === "student") {
      quizzes = quizzes.filter(quiz =>
        quiz.published !== false &&
        studentMatchesItem(quiz, req.user)
      );
    } else if (norm(req.user.role) !== "teacher") {
      return res.status(403).json({ message: "Access denied." });
    }

    quizzes.sort(
      (a, b) =>
        new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    res.json({
      quizzes: quizzes.map(quiz => publicQuiz(quiz, false))
    });
  } catch (error) {
    console.error("Load quizzes error:", error);
    res.status(500).json({ message: "Unable to load quizzes." });
  }
});

/* =========================
   QUIZZES: GET ONE
========================= */

app.get("/api/quizzes/:id", authenticate, (req, res) => {
  try {
    const db = readDB();
    const quiz = db.quizzes.find(
      item => String(item.id) === String(req.params.id)
    );

    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found." });
    }

    if (!["student", "teacher"].includes(norm(req.user.role))) {
      return res.status(403).json({ message: "Access denied." });
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

    res.json({ quiz: publicQuiz(quiz, false) });
  } catch (error) {
    console.error("Load quiz error:", error);
    res.status(500).json({ message: "Unable to load quiz." });
  }
});

/* =========================
   QUIZZES: DELETE
========================= */

app.delete(
  "/api/quizzes/:id",
  authenticate,
  requireTeacher,
  (req, res) => {
    try {
      const db = readDB();
      const index = db.quizzes.findIndex(
        item => String(item.id) === String(req.params.id)
      );

      if (index === -1) {
        return res.status(404).json({ message: "Quiz not found." });
      }

      db.quizzes.splice(index, 1);
      db.quizResults = db.quizResults.filter(
        result => String(result.quizId) !== String(req.params.id)
      );

      writeDB(db);
      res.json({ message: "Quiz deleted successfully." });
    } catch (error) {
      console.error("Delete quiz error:", error);
      res.status(500).json({ message: "Unable to delete quiz." });
    }
  }
);

/* =========================
   QUIZZES: SUBMIT ANSWERS
========================= */

app.post(
  "/api/quizzes/:id/submit",
  authenticate,
  requireStudent,
  (req, res) => {
    try {
      const db = readDB();
      const quiz = db.quizzes.find(
        item => String(item.id) === String(req.params.id)
      );

      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found." });
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
      writeDB(db);

      res.status(201).json({
        message: "Quiz submitted successfully.",
        result
      });
    } catch (error) {
      console.error("Submit quiz error:", error);
      res.status(500).json({ message: "Unable to submit quiz." });
    }
  }
);

/* =========================
   QUIZ RESULT HISTORY
========================= */

app.get("/api/quiz-results", authenticate, (req, res) => {
  try {
    const db = readDB();
    let results = [];

    if (norm(req.user.role) === "student") {
      results = db.quizResults.filter(
        result => String(result.studentId) === String(req.user.id)
      );
    } else if (norm(req.user.role) === "teacher") {
      results = [...db.quizResults];

      if (req.query.quizId) {
        results = results.filter(
          result => String(result.quizId) === String(req.query.quizId)
        );
      }
    } else {
      return res.status(403).json({ message: "Access denied." });
    }

    results.sort(
      (a, b) =>
        new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
    );

    res.json({ results });
  } catch (error) {
    console.error("Load quiz results error:", error);
    res.status(500).json({
      message: "Unable to load quiz results."
    });
  }
});

/* =========================
   API 404
========================= */

app.use("/api", (req, res) => {
  res.status(404).json({ message: "API route not found." });
});

/* =========================
   ERROR HANDLER
========================= */

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "PDF must be 15 MB or smaller."
        : "File upload failed: " + error.message;

    return res.status(400).json({ message });
  }

  if (error.message === "Only PDF files are allowed.") {
    return res.status(400).json({ message: error.message });
  }

  res.status(500).json({
    message: "Unexpected server error."
  });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log("------------------------------------");
  console.log("       CAMPUSNOTES SERVER");
  console.log("------------------------------------");
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("Registration API: READY");
  console.log("Login API: READY");
  console.log("Student notes API: READY");
  console.log("Teacher notes CRUD: READY");
  console.log("PDF upload API: READY");
  console.log("Quiz API: READY");
  console.log("Publish Quiz API: READY");
  console.log("Quiz results API: READY");
  console.log("------------------------------------");
});
