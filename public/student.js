const token =
    localStorage.getItem(
        "campusnotes_token"
    );


const user =
    JSON.parse(
        localStorage.getItem(
            "campusnotes_user"
        ) || "{}"
    );


if (
    !token ||
    user.role !== "student"
) {

    window.location.href =
        "student-login.html";
}


document.getElementById(
    "studentName"
).textContent =
    user.name || "Student";


document.getElementById(
    "welcomeName"
).textContent =
    user.name || "Student";


document.getElementById(
    "studentBranch"
).textContent =
    user.branch || "-";


document.getElementById(
    "studentCourse"
).textContent =
    user.course || "-";


document.getElementById(
    "studentSemester"
).textContent =
    user.semester || "-";


async function loadNotes() {

    const search =
        document.getElementById(
            "search"
        ).value.trim();


    let url =
        "/api/notes";


    if (search) {

        url +=
            "?search=" +
            encodeURIComponent(search);
    }


    try {

        const response =
            await fetch(
                url,
                {
                    headers: {
                        Authorization:
                            "Bearer " +
                            token
                    }
                }
            );


        const data =
            await response.json();


        if (!data.success) {

            logout();

            return;
        }


        let notes =
            data.notes;


        if (search) {

            const keyword =
                search.toLowerCase();


            notes =
                notes.filter(note =>

                    note.title
                        .toLowerCase()
                        .includes(keyword)

                    ||

                    note.subject
                        .toLowerCase()
                        .includes(keyword)

                    ||

                    note.description
                        .toLowerCase()
                        .includes(keyword)

                );
        }


        displayNotes(notes);

    } catch {

        document.getElementById(
            "notesContainer"
        ).innerHTML = `

            <div class="empty-state">

                <div>⚠️</div>

                <h3>
                    Unable to load notes
                </h3>

                <p>
                    Please check the server.
                </p>

            </div>
        `;
    }
}


function displayNotes(notes) {

    const container =
        document.getElementById(
            "notesContainer"
        );


    document.getElementById(
        "noteCount"
    ).textContent =
        notes.length +
        " Note" +
        (notes.length !== 1
            ? "s"
            : ""
        );


    if (notes.length === 0) {

        container.innerHTML = `

            <div class="empty-state">

                <div>📚</div>

                <h3>
                    No Notes Available
                </h3>

                <p>
                    Notes for your Branch,
                    Course and Semester
                    have not been uploaded yet.
                </p>

            </div>
        `;

        return;
    }


    container.innerHTML =
        notes.map(note => `

            <div class="note-card">

                <div class="pdf-icon">
                    PDF
                </div>


                <div class="note-content">

                    <span class="semester-tag">
                        ${escapeHTML(
                            note.semester
                        )}
                    </span>


                    <h3>
                        ${escapeHTML(
                            note.title
                        )}
                    </h3>


                    <p class="subject">
                        ${escapeHTML(
                            note.subject
                        )}
                    </p>


                    <p>
                        ${escapeHTML(
                            note.description ||
                            "Study Notes"
                        )}
                    </p>


                    <small>
                        Uploaded by
                        ${escapeHTML(
                            note.uploadedBy
                        )}
                    </small>

                </div>


                <div class="note-actions">

                    <a
                        href="${note.fileUrl}"
                        target="_blank"
                        class="btn small secondary"
                    >
                        View
                    </a>


                    <a
                        href="${note.fileUrl}"
                        download
                        class="btn small primary"
                    >
                        Download
                    </a>

                </div>

            </div>

        `).join("");
}


function escapeHTML(value) {

    return String(value)

        .replace(
            /&/g,
            "&amp;"
        )

        .replace(
            /</g,
            "&lt;"
        )

        .replace(
            />/g,
            "&gt;"
        )

        .replace(
            /"/g,
            "&quot;"
        )

        .replace(
            /'/g,
            "&#039;"
        );
}


function logout() {

    localStorage.removeItem(
        "campusnotes_token"
    );

    localStorage.removeItem(
        "campusnotes_user"
    );


    window.location.href =
        "student-login.html";
}


document
.getElementById("search")
.addEventListener(
    "keydown",
    function(e) {

        if (e.key === "Enter") {
            loadNotes();
        }

    }
);


loadNotes();