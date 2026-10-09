
"use strict";

/* CampusNotes Teacher Dashboard */

const $ = id => document.getElementById(id);
const token = localStorage.getItem("campusnotes_token");

let notes = [];
let quizzes = [];
let editingNoteId = null;
let questionCounter = 0;

if (!token) {
  window.location.replace("/teacher-login.html");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function normalizeCourse(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "btech" || v === "b.tech" ? "b.tech" : v;
}

function normalizeBranch(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return ["civil", "ce", "civil engineering", "ce (civil)"].includes(v)
    ? "ce"
    : v;
}

function normalizeSemester(value) {
  const match = String(value ?? "").match(/[1-8]/);
  return match ? match[0] : "";
}

function getId(item) {
  return item?.id ?? item?._id ?? item?.noteId ?? item?.quizId;
}

function getFileUrl(note) {
  if (note.fileUrl) return note.fileUrl;

  const filename = note.fileName || note.filename || "";
  if (!filename) return "";

  return "/uploads/" +
    encodeURIComponent(filename.split(/[\\/]/).pop());
}

function setMessage(id, message, type = "info") {
  const el = $(id);
  if (!el) return;

  const colors = {
    info: "#667085",
    success: "#067647",
    error: "#b42318"
  };

  el.style.color = colors[type] || colors.info;
  el.textContent = message || "";
}

/* API helper */

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", "Bearer " + token);

  const response = await fetch(url, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    localStorage.removeItem("campusnotes_token");
    window.location.replace("/teacher-login.html");
    throw new Error("Your session has expired. Please log in again.");
  }

  if (!response.ok) {
    throw new Error(data.message || "Request failed (" + response.status + ").");
  }

  return data;
}

function getArray(data, key) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : [];
}

/* Sidebar navigation */

document.querySelectorAll("[data-view]").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    document.querySelectorAll(".view").forEach(view => {
      view.classList.toggle("active", view.id === button.dataset.view);
    });

    if (button.dataset.view === "libraryView") loadNotes();
    if (button.dataset.view === "quizView") loadQuizzes();

    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

/* Logout */

$("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("campusnotes_token");
  window.location.href = "/teacher-login.html";
});

/* Teacher profile */

async function loadTeacher() {
  try {
    const data = await api("/api/me");
    const user = data.user || data;

    if (user.name) {
      $("teacherName").textContent = user.name;
      document.querySelector(".avatar").textContent =
        user.name.trim().charAt(0).toUpperCase();
    }
  } catch (error) {
    console.error("Teacher profile:", error.message);
  }
}

/* Course and branch fields */

function setupBranchField(courseId, wrapId, branchId) {
  const course = $(courseId);
  const wrap = $(wrapId);
  const branch = $(branchId);

  function update() {
    const needsBranch = ["Diploma", "B.Tech"].includes(course.value);

    wrap.classList.toggle("hidden", !needsBranch);
    branch.disabled = !needsBranch;
    branch.required = needsBranch;

    if (!needsBranch) branch.value = "";
  }

  course.addEventListener("change", update);
  update();
}

setupBranchField("course", "branchWrap", "branch");
setupBranchField("quizCourse", "quizBranchWrap", "quizBranch");

/* Notes form */

const noteForm = $("noteForm");
const noteFile = $("file");
const noteSubmit = $("submitBtn");

function resetNoteForm() {
  noteForm.reset();
  editingNoteId = null;

  $("formTitle").textContent = "Upload New Notes";
  $("noteMode").textContent = "NEW NOTE";
  noteSubmit.textContent = "Upload Notes";
  $("fileRequired").classList.remove("hidden");
  $("fileHelp").textContent =
    "PDF only. Keep the file size within the server's upload limit.";

  $("course").dispatchEvent(new Event("change"));
  setMessage("formMessage", "");
}

$("clearBtn").addEventListener("click", resetNoteForm);

$("newNoteBtn").addEventListener("click", () => {
  document.querySelector('[data-view="notesView"]').click();
  $("uploadPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  $("title").focus();
});

noteForm.addEventListener("submit", async event => {
  event.preventDefault();

  const isEditing = editingNoteId !== null;
  const selectedFile = noteFile.files[0];

  if (!isEditing && !selectedFile) {
    setMessage("formMessage", "Please select a PDF file.", "error");
    return;
  }

  if (selectedFile) {
    const isPdf = selectedFile.type === "application/pdf" ||
      selectedFile.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      setMessage("formMessage", "Please select a PDF file.", "error");
      return;
    }
  }

  const course = $("course").value;
  const branch = ["Diploma", "B.Tech"].includes(course)
    ? $("branch").value
    : "";

  const formData = new FormData();
  formData.append("title", $("title").value.trim());
  formData.append("subject", $("subject").value.trim());
  formData.append("course", course);
  formData.append("branch", branch);
  formData.append("semester", $("semester").value);
  formData.append("description", $("description").value.trim());

  if (selectedFile) {
    formData.append("file", selectedFile);
  }

  noteSubmit.disabled = true;
  noteSubmit.textContent = isEditing ? "Saving..." : "Uploading...";
  setMessage("formMessage", "Please wait...");

  try {
    const url = isEditing
      ? "/api/notes/" + encodeURIComponent(editingNoteId)
      : "/api/notes";

    const result = await api(url, {
      method: isEditing ? "PUT" : "POST",
      body: formData
    });

    resetNoteForm();
    await loadNotes();

    setMessage(
      "formMessage",
      result.message || (isEditing
        ? "Notes updated successfully."
        : "Notes uploaded successfully."),
      "success"
    );

    document.querySelector('[data-view="libraryView"]').click();
  } catch (error) {
    setMessage("formMessage", error.message, "error");
  } finally {
    noteSubmit.disabled = false;
    noteSubmit.textContent =
      editingNoteId !== null ? "Save Changes" : "Upload Notes";
  }
});

/* Notes library */

function renderNotes() {
  const search = $("search").value.trim().toLowerCase();
  const course = $("filterCourse").value;
  const branch = $("filterBranch").value;
  const semester = $("filterSemester").value;

  const filtered = notes.filter(note => {
    const text = (String(note.title || "") + " " +
      String(note.subject || "")).toLowerCase();

    return text.includes(search) &&
      (!course || normalizeCourse(note.course) === normalizeCourse(course)) &&
      (!branch || normalizeBranch(note.branch) === normalizeBranch(branch)) &&
      (!semester || normalizeSemester(note.semester) === semester);
  });

  $("totalNotes").textContent = notes.length;
  $("totalCourses").textContent =
    new Set(notes.map(note => normalizeCourse(note.course)).filter(Boolean)).size;
  $("totalPDFs").textContent =
    notes.filter(note => getFileUrl(note)).length;

  if (!filtered.length) {
    $("notesBody").innerHTML =
      '<tr><td colspan="6" class="empty">No notes found. Try another filter or upload notes.</td></tr>';
    return;
  }

  $("notesBody").innerHTML = filtered.map(note => {
    const id = getId(note);
    const fileUrl = getFileUrl(note);

    return `
      <tr>
        <td>
          <strong>${escapeHTML(note.title || "Untitled")}</strong>
          <span class="smalltext">${escapeHTML(note.subject || "")}</span>
        </td>
        <td><span class="badge">${escapeHTML(note.course || "—")}</span></td>
        <td>${escapeHTML(note.branch || "—")}</td>
        <td>${escapeHTML(note.semester || "—")}</td>
        <td>${fileUrl
          ? `<a class="btn secondary" href="${escapeHTML(fileUrl)}" target="_blank" rel="noopener">View PDF</a>`
          : '<span class="smalltext">No PDF</span>'}</td>
        <td>
          <div class="table-actions">
            <button class="btn secondary" type="button" data-edit-note="${escapeHTML(id)}">Edit</button>
            <button class="btn danger" type="button" data-delete-note="${escapeHTML(id)}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

async function loadNotes() {
  $("notesBody").innerHTML =
    '<tr><td colspan="6" class="empty">Loading notes...</td></tr>';

  try {
    const data = await api("/api/notes");
    notes = getArray(data, "notes");
    setMessage("libraryMessage", "");
    renderNotes();
  } catch (error) {
    $("notesBody").innerHTML =
      '<tr><td colspan="6" class="empty">Unable to load notes.</td></tr>';
    setMessage("libraryMessage", error.message, "error");
  }
}

["search", "filterCourse", "filterBranch", "filterSemester"].forEach(id => {
  $(id).addEventListener("input", renderNotes);
  $(id).addEventListener("change", renderNotes);
});

$("refreshNotesBtn").addEventListener("click", loadNotes);

$("notesBody").addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit-note]");
  const deleteButton = event.target.closest("[data-delete-note]");

  if (editButton) {
    const note = notes.find(item =>
      String(getId(item)) === editButton.dataset.editNote
    );

    if (!note) return;

    editingNoteId = getId(note);
    $("title").value = note.title || "";
    $("subject").value = note.subject || "";
    $("course").value = note.course || "";
    $("course").dispatchEvent(new Event("change"));
    $("branch").value = note.branch || "";
    $("semester").value = normalizeSemester(note.semester);
    $("description").value = note.description || "";
    $("file").value = "";

    $("formTitle").textContent = "Edit Notes";
    $("noteMode").textContent = "EDITING";
    $("submitBtn").textContent = "Save Changes";
    $("fileRequired").classList.add("hidden");
    $("fileHelp").textContent =
      "Optional: select a replacement PDF. Leave blank to keep the existing file.";

    setMessage("formMessage", "Update the fields and select Save Changes.");
    document.querySelector('[data-view="notesView"]').click();
    $("uploadPanel").scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (deleteButton) {
    const id = deleteButton.dataset.deleteNote;

    if (!confirm("Delete these notes permanently?")) return;

    deleteButton.disabled = true;

    try {
      const result = await api("/api/notes/" + encodeURIComponent(id), {
        method: "DELETE"
      });

      setMessage("libraryMessage", result.message || "Notes deleted.", "success");
      await loadNotes();
    } catch (error) {
      setMessage("libraryMessage", error.message, "error");
      deleteButton.disabled = false;
    }
  }
});

/* Quiz question builder */

const questionsContainer = $("questionsContainer");

function renumberQuestions() {
  questionsContainer.querySelectorAll(".question-card").forEach((card, index) => {
    card.querySelector(".question-number").textContent = "Question " + (index + 1);
  });
}

function addQuestion(question = null) {
  questionCounter++;

  const card = document.createElement("div");
  card.className = "question-card";

  const options = Array.isArray(question?.options)
    ? question.options
    : ["", "", "", ""];

  const correct = Number.isInteger(question?.correctAnswer)
    ? question.correctAnswer
    : 0;

  card.innerHTML = `
    <div class="question-head">
      <h3 class="question-number">Question ${questionCounter}</h3>
      <button class="btn danger remove-question" type="button">Remove</button>
    </div>

    <div class="field">
      <label>Question *</label>
      <textarea class="question-text" required maxlength="1000"
        placeholder="Enter the question">${escapeHTML(question?.text || "")}</textarea>
    </div>

    <div class="formgrid">
      ${options.map((option, index) => `
        <div class="field">
          <label>Option ${String.fromCharCode(65 + index)} *</label>
          <input class="question-option" required maxlength="500"
            value="${escapeHTML(option)}"
            placeholder="Enter option ${String.fromCharCode(65 + index)}">
        </div>
      `).join("")}
    </div>

    <div class="field">
      <label>Correct Answer *</label>
      <select class="correct-answer" required>
        <option value="0" ${correct === 0 ? "selected" : ""}>Option A</option>
        <option value="1" ${correct === 1 ? "selected" : ""}>Option B</option>
        <option value="2" ${correct === 2 ? "selected" : ""}>Option C</option>
        <option value="3" ${correct === 3 ? "selected" : ""}>Option D</option>
      </select>
    </div>
  `;

  card.querySelector(".remove-question").addEventListener("click", () => {
    card.remove();
    renumberQuestions();
  });

  questionsContainer.appendChild(card);
  renumberQuestions();
}

$("addQuestionBtn").addEventListener("click", () => addQuestion());

function readQuestions() {
  const cards = [...questionsContainer.querySelectorAll(".question-card")];

  return cards.map((card, index) => ({
    id: String(index + 1),
    text: card.querySelector(".question-text").value.trim(),
    options: [...card.querySelectorAll(".question-option")]
      .map(input => input.value.trim()),
    correctAnswer: Number(card.querySelector(".correct-answer").value)
  }));
}

function resetQuizForm() {
  $("quizForm").reset();
  questionsContainer.innerHTML = "";
  questionCounter = 0;
  addQuestion();
  $("quizFormTitle").textContent = "Create a New Quiz";
  $("saveQuizBtn").textContent = "Create Quiz";
  $("quizCourse").dispatchEvent(new Event("change"));
  setMessage("quizMessage", "");
}

$("clearQuizBtn").addEventListener("click", resetQuizForm);

$("quizForm").addEventListener("submit", async event => {
  event.preventDefault();

  const questions = readQuestions();

  if (!questions.length) {
    setMessage("quizMessage", "Add at least one question.", "error");
    return;
  }

  const invalidQuestion = questions.some(question =>
    !question.text ||
    question.options.length !== 4 ||
    question.options.some(option => !option) ||
    !Number.isInteger(question.correctAnswer) ||
    question.correctAnswer < 0 ||
    question.correctAnswer > 3
  );

  if (invalidQuestion) {
    setMessage(
      "quizMessage",
      "Complete every question, all four options and its correct answer.",
      "error"
    );
    return;
  }

  const course = $("quizCourse").value;
  const branch = ["Diploma", "B.Tech"].includes(course)
    ? $("quizBranch").value
    : "";

  const payload = {
    title: $("quizTitle").value.trim(),
    subject: $("quizSubject").value.trim(),
    course,
    branch,
    semester: $("quizSemester").value,
    questions
  };

  const button = $("saveQuizBtn");
  button.disabled = true;
  button.textContent = "Creating Quiz...";

  try {
    const result = await api("/api/quizzes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    resetQuizForm();
    setMessage(
      "quizMessage",
      result.message || "Quiz created successfully. Publish it when ready.",
      "success"
    );

    await loadQuizzes();
  } catch (error) {
    setMessage("quizMessage", error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Create Quiz";
  }
});

/* Quiz status helper */

function isQuizPublished(quiz) {
  // Older quizzes without a published field remain treated as published.
  return quiz.published !== false;
}

/* Existing quiz list + Publish Quiz */

async function loadQuizzes() {
  $("quizList").innerHTML =
    '<div class="empty">Loading quizzes...</div>';

  try {
    const data = await api("/api/quizzes");
    quizzes = getArray(data, "quizzes");

    if (!quizzes.length) {
      $("quizList").innerHTML =
        '<div class="empty">No quizzes created yet. Use the form above to create one.</div>';
      return;
    }

    $("quizList").innerHTML = quizzes.map(quiz => {
      const id = getId(quiz);
      const count = Array.isArray(quiz.questions)
        ? quiz.questions.length
        : 0;

      const published = isQuizPublished(quiz);

      const statusHTML = published
        ? '<span class="badge" style="background:#dcfae6;color:#067647;">Published</span>'
        : '<span class="badge" style="background:#fef0c7;color:#93370d;">Draft</span>';

      const publishButton = published
        ? ""
        : `<button type="button"
             class="btn primary"
             data-publish-quiz="${escapeHTML(id)}">
             Publish Quiz
           </button>`;

      return `
        <div class="quiz-item">
          <div>
            <div class="quiz-title">${escapeHTML(quiz.title || "Untitled Quiz")}</div>
            <div class="quiz-meta">
              ${escapeHTML(quiz.subject || "No subject")}
              · ${escapeHTML(quiz.course || "No course")}
              ${quiz.branch ? " · " + escapeHTML(quiz.branch) : ""}
              · Semester ${escapeHTML(quiz.semester || "—")}
              · ${count} question(s)
            </div>
            <div style="margin-top:10px;">${statusHTML}</div>
          </div>

          <div class="table-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
            ${publishButton}
            <button type="button"
              class="btn danger"
              data-delete-quiz="${escapeHTML(id)}">
              Delete Quiz
            </button>
          </div>
        </div>
      `;
    }).join("");
  } catch (error) {
    $("quizList").innerHTML =
      '<div class="empty">Unable to load quizzes.</div>';
    setMessage("quizMessage", error.message, "error");
  }
}

$("refreshQuizzesBtn").addEventListener("click", loadQuizzes);

/* Publish and delete actions */

$("quizList").addEventListener("click", async event => {
  const publishButton = event.target.closest("[data-publish-quiz]");
  const deleteButton = event.target.closest("[data-delete-quiz]");

  /* Publish quiz */

  if (publishButton) {
    const id = publishButton.dataset.publishQuiz;

    if (!confirm("Publish this quiz for eligible students?")) {
      return;
    }

    publishButton.disabled = true;
    publishButton.textContent = "Publishing...";

    try {
      const result = await api(
        "/api/quizzes/" + encodeURIComponent(id) + "/publish",
        { method: "PATCH" }
      );

      setMessage(
        "quizMessage",
        result.message || "Quiz published successfully.",
        "success"
      );

      await loadQuizzes();
    } catch (error) {
      setMessage("quizMessage", error.message, "error");
      publishButton.disabled = false;
      publishButton.textContent = "Publish Quiz";
    }

    return;
  }

  /* Delete quiz */

  if (deleteButton) {
    const id = deleteButton.dataset.deleteQuiz;

    if (!confirm("Delete this quiz? Students may no longer be able to take it.")) {
      return;
    }

    deleteButton.disabled = true;

    try {
      const result = await api(
        "/api/quizzes/" + encodeURIComponent(id),
        { method: "DELETE" }
      );

      setMessage(
        "quizMessage",
        result.message || "Quiz deleted successfully.",
        "success"
      );

      await loadQuizzes();
    } catch (error) {
      setMessage("quizMessage", error.message, "error");
      deleteButton.disabled = false;
    }
  }
});

/* Start dashboard */

loadTeacher();
loadNotes();
loadQuizzes();
