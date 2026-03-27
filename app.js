const PAGE_SIZE = 30;

const state = {
  detailsOpen: false,
  loading: true,
  error: "",
  notice: "",
  filters: {
    scope: "total",
    week: getCurrentWeek(),
    day: getToday(),
    memberId: "",
    tags: [],
    query: "",
    page: 1,
  },
  draft: {
    memberId: "",
    text: "",
    tags: "",
  },
  editDraft: {
    text: "",
    tags: "",
  },
  authDraft: {
    mode: "login",
    loginUsername: "",
    loginPassword: "",
    loginRemember: true,
    registerName: "",
    registerUsername: "",
    registerPassword: "",
    registerRemember: true,
  },
  adminDraft: {
    name: "",
  },
  dashboard: null,
  focusFactId: getFactIdFromUrl(),
  editingFactId: "",
  voice: {
    supported: getSpeechRecognitionClass() !== null,
    listening: false,
    loading: false,
    status: "",
    transcript: "",
  },
};

let searchDebounce = null;
let noticeTimer = null;
let activeRecognition = null;
const app = document.querySelector("#app");

bootstrap();

async function bootstrap() {
  if (state.focusFactId) {
    state.detailsOpen = true;
  }
  state.loading = true;
  render();
  await loadDashboard();
}

async function loadDashboard() {
  state.loading = true;
  state.error = "";
  render();

  try {
    const params = new URLSearchParams({
      scope: state.filters.scope,
      week: state.filters.week,
      day: state.filters.day,
      q: state.filters.query,
      page: String(state.filters.page),
      pageSize: String(PAGE_SIZE),
    });

    if (state.filters.memberId) {
      params.set("memberId", state.filters.memberId);
    }

    if (state.focusFactId) {
      params.set("focusFactId", state.focusFactId);
    }

    state.filters.tags.forEach((tag) => params.append("tag", tag));

    const response = await fetch(`/api/dashboard?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Не удалось загрузить данные.");
    }

    state.dashboard = payload;

    const activeMember = payload.members.find((member) => member.inTeam);
    const targetExists = payload.members.some((member) => member.id === state.draft.memberId && member.inTeam);
    if (!targetExists) {
      state.draft.memberId = activeMember?.id || "";
    }

    if (payload.focusFactId) {
      state.detailsOpen = true;
    }

    if (!payload.currentUser) {
      state.editingFactId = "";
    }
  } catch (error) {
    state.error = error.message || "Не удалось загрузить данные.";
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  if (state.loading && !state.dashboard) {
    app.innerHTML = `
      <main class="shell">
        <section class="hero">
          <article class="hero-copy">
            <div class="brand">
              <span class="eyebrow">Vaulty · копилка фактов команды</span>
              <h1>Факты, которые делают команду живой.</h1>
              <p>Поднимаю копилку, факты и личные кабинеты...</p>
            </div>
          </article>
          <section class="hero-stage">
            <span class="stage-ribbon">Загрузка данных</span>
          </section>
        </section>
      </main>
    `;
    return;
  }

  const dashboard = state.dashboard || emptyDashboard();
  const currentUser = dashboard.currentUser;
  if (!currentUser) {
    app.innerHTML = renderAuthPage();
    bindAuthEvents();
    return;
  }

  const membersInTeam = dashboard.members.filter((member) => member.inTeam).length;
  const topMember = dashboard.leaderboard.find((member) => member.count > 0);
  const pagination = dashboard.pagination;
  const canCreateFacts = dashboard.members.some((member) => member.inTeam);
  const activeMemberFilter = dashboard.memberFilter || null;

  app.innerHTML = `
    <main class="shell">
      <section class="hero">
        <article class="hero-copy">
          <div class="brand">
            <span class="eyebrow">Vaulty · копилка фактов команды</span>
            <h1>Факты, которые делают команду живой.</h1>
            <p>
              Здесь можно складывать смешные, полезные и немного кринжовые наблюдения из рабочих разговоров,
              заходить в свой кабинет, редактировать собственные факты и делиться прямой ссылкой на каждую запись.
            </p>
          </div>

          <div class="hero-metrics">
            <div class="metric">
              <strong>${dashboard.totalFacts}</strong>
              <span>всего фактов в копилке</span>
            </div>
            <div class="metric">
              <strong>${membersInTeam}</strong>
              <span>участников сейчас в команде</span>
            </div>
            <div class="metric">
              <strong>${dashboard.tags.length}</strong>
              <span>тегов для фильтрации</span>
            </div>
          </div>
        </article>

        <section class="hero-stage">
          <span class="stage-ribbon">Нажми на копилку и открой детализацию</span>
          <button class="piggy-trigger" id="toggle-details" aria-expanded="${String(state.detailsOpen)}" aria-controls="workspace">
            <div class="piggy-bank" aria-hidden="true">
              <div class="piggy-body"></div>
              <div class="piggy-slot"></div>
              <div class="piggy-nose"></div>
              <div class="piggy-eye"></div>
              <div class="piggy-tail"></div>
              <div class="piggy-leg is-front"></div>
              <div class="piggy-leg is-back"></div>
              <div class="piggy-coin">V</div>
            </div>

            <div class="piggy-total">
              <div>
                <strong>${dashboard.filteredTotal}</strong>
                <span>${getScopeLabel(state.filters)}</span>
              </div>
              <div class="toggle-hint">
                ${state.detailsOpen ? "Скрыть рейтинг и поток фактов" : "Открыть рейтинг участников и все факты"}
              </div>
            </div>
          </button>
        </section>
      </section>

      <section class="workspace" id="workspace" ${state.detailsOpen ? "" : "hidden"}>
        <div class="workspace-top">
          <div>
            <h2 class="section-title">Разрез по людям, тегам и времени</h2>
            <p class="section-copy">
              Можно оставить общий тотал, выбрать конкретную неделю или день, отфильтровать факты по тегам,
              найти их по словам, поделиться прямой ссылкой и редактировать собственные записи.
            </p>
          </div>
          <button class="ghost-button" id="collapse-details">Свернуть детализацию</button>
        </div>

        ${state.error ? `<div class="panel error-banner">${escapeHtml(state.error)}</div>` : ""}
        ${state.notice ? `<div class="panel notice-banner">${escapeHtml(state.notice)}</div>` : ""}

        <div class="workspace-grid">
          <aside class="panel">
            <div class="panel-head">
              <h3>Фильтры</h3>
              <span class="subtle">${dashboard.filteredTotal} найдено</span>
            </div>

            <div class="filters">
              <div class="filters-row">
                <div class="field">
                  <label for="scope">Период</label>
                  <select id="scope">
                    <option value="total" ${state.filters.scope === "total" ? "selected" : ""}>Тотал</option>
                    <option value="week" ${state.filters.scope === "week" ? "selected" : ""}>Неделя</option>
                    <option value="day" ${state.filters.scope === "day" ? "selected" : ""}>День</option>
                  </select>
                </div>
                <div class="field" ${state.filters.scope === "week" ? "" : "hidden"}>
                  <label for="week">Выбери неделю</label>
                  <input id="week" type="week" value="${state.filters.week}" />
                </div>
                <div class="field" ${state.filters.scope === "day" ? "" : "hidden"}>
                  <label for="day">Выбери день</label>
                  <input id="day" type="date" value="${state.filters.day}" />
                </div>
              </div>

              <div class="field">
                <label for="fact-search">Поиск по ключевым словам</label>
                <input id="fact-search" type="search" value="${escapeHtml(state.filters.query)}" placeholder="Например: архитектура, ретро, cron" />
              </div>

              <div class="field">
                <label>Сотрудник</label>
                <div class="chips">
                  <button class="chip ${!state.filters.memberId ? "is-active" : ""}" data-member-filter="">
                    Все сотрудники
                  </button>
                  ${
                    activeMemberFilter
                      ? `
                        <button class="chip is-active" data-member-filter="${escapeHtml(activeMemberFilter.id)}">
                          ${escapeHtml(activeMemberFilter.name)}
                        </button>
                      `
                      : ""
                  }
                </div>
              </div>

              <div class="field">
                <label>Теги</label>
                <div class="chips">
                  <button class="chip ${state.filters.tags.length === 0 ? "is-active" : ""}" data-tag="__all__">Все</button>
                  ${dashboard.tags
                    .map(
                      (tag) => `
                        <button class="chip ${state.filters.tags.includes(tag) ? "is-active" : ""}" data-tag="${escapeHtml(tag)}">
                          #${escapeHtml(tag)}
                        </button>
                      `,
                    )
                    .join("")}
                </div>
              </div>
            </div>
          </aside>

          <section class="panel stack">
            <div class="panel-head">
              <div>
                <h3>Лидерборд</h3>
                <div class="subtle">
                  ${
                    activeMemberFilter
                      ? `Показываю факты сотрудника ${escapeHtml(activeMemberFilter.name)}. Нажми на имя еще раз, чтобы снять фильтр.`
                      : topMember
                        ? `Сейчас лидирует ${escapeHtml(topMember.name)}.`
                        : "В этом фильтре пока нет фактов."
                  }
                </div>
              </div>
              <div class="subtle">${dashboard.filteredTotal} фактов</div>
            </div>

            <div class="leaderboard">
              ${dashboard.leaderboard
                .map(
                  (member) => `
                    <button
                      class="leader-row ${state.filters.memberId === member.id ? "is-active" : ""}"
                      type="button"
                      data-member-filter="${member.id}"
                    >
                      <div class="leader-top">
                        <div class="leader-name">
                          <span class="leader-dot" style="background:${member.color}"></span>
                          <span>${escapeHtml(member.name)}</span>
                          ${renderMemberBadge(member)}
                        </div>
                        <strong>${member.count}</strong>
                      </div>
                      <div class="leader-bar">
                        <span style="width:${member.width}%; background:${member.color}"></span>
                      </div>
                    </button>
                  `,
                )
                .join("")}
            </div>
          </section>
        </div>

        <div class="panel-grid">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h3>Поток фактов</h3>
                <div class="subtle">30 фактов на страницу, поиск, share-link и редактирование своих записей.</div>
              </div>
              <div class="subtle">Страница ${pagination.page} из ${pagination.totalPages}</div>
            </div>

            <div class="facts">
              ${
                dashboard.facts.length
                  ? dashboard.facts.map((fact) => renderFactCard(fact, currentUser)).join("")
                  : '<div class="empty-state">Под эти фильтры пока ничего не нашлось. Попробуй убрать часть условий или добавить новый факт.</div>'
              }
            </div>

            <div class="pagination">
              <button class="ghost-button" data-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""}>Назад</button>
              <span class="pagination-state">${pagination.startItem}-${pagination.endItem} из ${pagination.totalItems}</span>
              <button class="ghost-button" data-page="${pagination.page + 1}" ${pagination.page >= pagination.totalPages ? "disabled" : ""}>Вперед</button>
            </div>
          </section>

          <section class="stack">
            ${renderAccountSummary(currentUser)}
            ${renderFactComposer(currentUser, canCreateFacts, dashboard.members)}
            ${renderAdminPanel(currentUser, dashboard.members)}
          </section>
        </div>
      </section>
    </main>
  `;

  bindEvents();
  maybeScrollToFocusedFact();
}

function renderAuthPage() {
  const isLogin = state.authDraft.mode === "login";
  return `
    <main class="auth-shell">
      <section class="auth-hero">
        <article class="auth-copy">
          <span class="eyebrow">Vaulty · копилка фактов команды</span>
          <h1>${isLogin ? "Вход в Vaulty" : "Регистрация в Vaulty"}</h1>
          <p>
            ${isLogin
              ? "Войди в свой кабинет, чтобы продолжить работу с копилкой фактов и публиковать новые записи от своего логина."
              : "Создай кабинет по имени, логину и паролю. После регистрации ты сразу попадешь в копилку фактов."}
          </p>
        </article>

        <article class="auth-panel">
          <div class="auth-switch" role="tablist" aria-label="Переключение между входом и регистрацией">
            <button
              class="auth-switch-button ${isLogin ? "is-active" : ""}"
              type="button"
              data-auth-mode="login"
              role="tab"
              aria-selected="${String(isLogin)}"
            >
              Вход
            </button>
            <button
              class="auth-switch-button ${!isLogin ? "is-active" : ""}"
              type="button"
              data-auth-mode="register"
              role="tab"
              aria-selected="${String(!isLogin)}"
            >
              Регистрация
            </button>
          </div>

          ${state.error ? `<div class="panel error-banner">${escapeHtml(state.error)}</div>` : ""}
          ${state.notice ? `<div class="panel notice-banner">${escapeHtml(state.notice)}</div>` : ""}

          <div class="auth-grid auth-grid--single">
            ${
              isLogin
                ? `
                  <form id="login-form" class="stack auth-card auth-card--single" autocomplete="on">
                    <h3>Вход в аккаунт</h3>
                    <div class="subtle auth-subcopy">Войди, чтобы продолжить работу с сохраненным прогрессом.</div>
                    <div class="field">
                      <label for="login-username">Логин</label>
                      <input
                        id="login-username"
                        name="username"
                        type="text"
                        value="${escapeHtml(state.authDraft.loginUsername)}"
                        placeholder="например lev"
                        autocomplete="username"
                        autocapitalize="none"
                        spellcheck="false"
                      />
                    </div>
                    <div class="field">
                      <label for="login-password">Пароль</label>
                      <input
                        id="login-password"
                        name="password"
                        type="password"
                        value="${escapeHtml(state.authDraft.loginPassword)}"
                        placeholder="Минимум 6 символов"
                        autocomplete="current-password"
                      />
                    </div>
                    <label class="remember-row" for="login-remember">
                      <input id="login-remember" name="rememberMe" type="checkbox" ${state.authDraft.loginRemember ? "checked" : ""} />
                      <span>Запомнить меня</span>
                    </label>
                    <div class="form-actions">
                      <button class="primary-button" type="submit">Войти</button>
                    </div>
                  </form>
                `
                : `
                  <form id="register-form" class="stack auth-card auth-card--single" autocomplete="on">
                    <h3>Создать аккаунт</h3>
                    <div class="subtle auth-subcopy">После регистрации ты сразу попадешь в копилку фактов команды.</div>
                    <div class="field">
                      <label for="register-name">Имя</label>
                      <input
                        id="register-name"
                        name="name"
                        type="text"
                        value="${escapeHtml(state.authDraft.registerName)}"
                        placeholder="Как к тебе обращаться"
                        autocomplete="name"
                      />
                    </div>
                    <div class="field">
                      <label for="register-username">Логин</label>
                      <input
                        id="register-username"
                        name="username"
                        type="text"
                        value="${escapeHtml(state.authDraft.registerUsername)}"
                        placeholder="например lev"
                        autocomplete="username"
                        autocapitalize="none"
                        spellcheck="false"
                      />
                    </div>
                    <div class="field">
                      <label for="register-password">Пароль</label>
                      <input
                        id="register-password"
                        name="password"
                        type="password"
                        value="${escapeHtml(state.authDraft.registerPassword)}"
                        placeholder="Минимум 6 символов"
                        autocomplete="new-password"
                      />
                    </div>
                    <label class="remember-row" for="register-remember">
                      <input id="register-remember" name="rememberMe" type="checkbox" ${state.authDraft.registerRemember ? "checked" : ""} />
                      <span>Запомнить меня</span>
                    </label>
                    <div class="form-actions">
                      <button class="primary-button" type="submit">Создать аккаунт</button>
                    </div>
                  </form>
                `
            }
          </div>
        </article>
      </section>
    </main>
  `;
}

function renderAccountSummary(currentUser) {
  return `
    <article class="panel">
      <div class="panel-head">
        <div>
          <h3>Личный кабинет</h3>
          <div class="subtle">Ты вошел в систему и все новые факты публикуются от твоего имени.</div>
        </div>
      </div>
      <div class="account-badge">
        <div>
          <strong>${escapeHtml(currentUser.name)} (${escapeHtml(currentUser.username)})</strong>
          <div class="subtle">Авторство новых фактов автоматически закрепляется за этим кабинетом.</div>
        </div>
        <button class="ghost-button" type="button" id="logout-button">Выйти</button>
      </div>
    </article>
  `;
}

function renderFactComposer(currentUser, canCreateFacts, members) {
  const teamMembers = members.filter((member) => member.inTeam);
  if (!currentUser) {
    return `
      <article class="panel">
        <div class="panel-head">
          <div>
            <h3>Новый факт</h3>
            <div class="subtle">Добавление фактов откроется после входа в личный кабинет.</div>
          </div>
        </div>
        <div class="empty-state">Сначала войди или зарегистрируйся, чтобы создавать факты от своего имени.</div>
      </article>
    `;
  }

  return `
    <article class="panel">
      <div class="panel-head">
        <div>
          <h3>Новый факт</h3>
          <div class="subtle">Пост публикуется от ${escapeHtml(currentUser.name)} (${escapeHtml(currentUser.username)}). Ниже ты выбираешь только того, к кому относится факт.</div>
        </div>
      </div>

      <form id="fact-form" class="stack">
        <div class="field">
          <label for="member">Кто сказал или принес факт</label>
          <select id="member" name="memberId" ${!canCreateFacts ? "disabled" : ""}>
            ${teamMembers
              .map(
                (member) => `
                  <option value="${member.id}" ${state.draft.memberId === member.id ? "selected" : ""}>
                    ${escapeHtml(member.name)}
                  </option>
                `,
              )
              .join("")}
          </select>
        </div>

        <div class="field">
          <label for="fact-text">Факт</label>
          <textarea id="fact-text" name="text" placeholder="Например: всегда называет самые сложные баги по имени.">${escapeHtml(state.draft.text)}</textarea>
        </div>

        <div class="field">
          <label for="fact-tags">Теги</label>
          <input id="fact-tags" name="tags" type="text" value="${escapeHtml(state.draft.tags)}" placeholder="забавно, полезно, кринж" />
        </div>

        <div class="voice-box ${state.voice.listening ? "is-live" : ""}">
          <div>
            <strong>Голосовой ввод</strong>
            <div class="subtle">
              ${
                state.voice.supported
                  ? "Надиктуй длинную мысль, я сокращу ее в короткий черновик с тегами. Отправка произойдет только после нажатия на кнопку отправки."
                  : "В этом браузере нет встроенного распознавания речи. Лучше всего попробовать Chrome или Safari."
              }
            </div>
            ${state.voice.status ? `<div class="voice-status">${escapeHtml(state.voice.status)}</div>` : ""}
            ${state.voice.transcript ? `<div class="voice-transcript">${escapeHtml(state.voice.transcript)}</div>` : ""}
          </div>
          <button class="ghost-button" type="button" id="voice-capture" ${!state.voice.supported || state.voice.loading ? "disabled" : ""}>
            ${state.voice.listening ? "Остановить" : state.voice.loading ? "Суммаризирую..." : "Надиктовать голосом"}
          </button>
        </div>

        <div class="form-actions">
          <button class="primary-button" type="submit" ${!canCreateFacts ? "disabled" : ""}>Отправить</button>
          <button class="ghost-button" type="button" id="fill-demo">Заполнить примером</button>
        </div>
      </form>
    </article>
  `;
}

function renderAdminPanel(currentUser, members) {
  if (!currentUser) {
    return "";
  }

  return `
    <article class="panel">
      <div class="panel-head">
        <div>
          <h3>Админ-панель</h3>
          <div class="subtle">Можно переименовывать, переключать статус и удалять участника, не теряя его факты.</div>
        </div>
      </div>

      <div class="participant-list">
        ${members
          .map(
            (member) => `
              <div class="participant-row">
                <div class="participant-meta">
                  <span class="leader-dot" style="background:${member.color}"></span>
                  <input
                    type="text"
                    value="${escapeHtml(member.name)}"
                    aria-label="Имя участника"
                    data-member-input="${member.id}"
                  />
                </div>
                <div class="participant-actions">
                  <button class="toggle-button ${member.inTeam ? "" : "is-off"}" data-toggle-member="${member.id}" data-in-team="${member.inTeam}">
                    ${member.inTeam ? "В команде" : "Не в команде"}
                  </button>
                  <button class="danger-button" data-delete-member="${member.id}" data-member-name="${escapeHtml(member.name)}">
                    Удалить
                  </button>
                </div>
                <span class="participant-note">${member.factCount} фактов за все время</span>
              </div>
            `,
          )
          .join("")}
      </div>

      <form id="member-form" class="stack" style="margin-top:18px;">
        <div class="field">
          <label for="member-name">Новый участник</label>
          <input id="member-name" name="name" type="text" value="${escapeHtml(state.adminDraft.name)}" placeholder="Например: Дима" />
        </div>
        <div class="form-actions">
          <button class="primary-button" type="submit">Добавить в команду</button>
        </div>
      </form>

      <div class="footer-note">
        Удаление участника скрывает его из состава, но все его прошлые факты остаются в истории, поиске и по прямым ссылкам.
      </div>
    </article>
  `;
}

function renderFactCard(fact, currentUser) {
  const canEdit = currentUser && [currentUser.id, currentUser.legacyMemberId].includes(fact.authorId);
  const isEditing = state.editingFactId === fact.id;
  const factUrl = getFactUrl(fact.id);

  return `
    <article class="fact-card ${state.focusFactId === fact.id ? "is-focused" : ""}" id="fact-${fact.id}">
      <div class="fact-top">
        <div class="fact-author">
          <span class="leader-dot" style="background:${fact.memberColor}"></span>
          <span>${escapeHtml(fact.memberName)}</span>
          ${fact.memberDeleted ? '<span class="status-pill is-muted">удален из команды</span>' : ""}
        </div>
        <span class="fact-date">${escapeHtml(fact.createdAtLabel)}</span>
      </div>

      <div class="fact-meta">
        <span>Добавил: ${escapeHtml(fact.authorName)}</span>
        ${fact.edited ? `<span>Обновлен: ${escapeHtml(fact.updatedAtLabel)}</span>` : ""}
      </div>

      ${
        isEditing
          ? `
            <div class="stack">
              <div class="field">
                <label for="edit-text-${fact.id}">Текст факта</label>
                <textarea id="edit-text-${fact.id}" data-edit-text="${fact.id}">${escapeHtml(state.editDraft.text)}</textarea>
              </div>
              <div class="field">
                <label for="edit-tags-${fact.id}">Теги</label>
                <input id="edit-tags-${fact.id}" type="text" data-edit-tags="${fact.id}" value="${escapeHtml(state.editDraft.tags)}" placeholder="забавно, полезно, кринж" />
              </div>
              <div class="fact-actions">
                <button class="primary-button" type="button" data-save-fact="${fact.id}">Сохранить</button>
                <button class="ghost-button" type="button" data-cancel-edit="${fact.id}">Отмена</button>
                <button class="ghost-button" type="button" data-copy-link="${fact.id}" data-copy-url="${escapeHtml(factUrl)}">Копировать ссылку</button>
              </div>
            </div>
          `
          : `
            <p class="fact-text">${escapeHtml(fact.text)}</p>
            <div class="chips">
              ${fact.tags
                .map(
                  (tag) => `
                    <button class="chip ${state.filters.tags.includes(tag) ? "is-active" : ""}" data-tag="${escapeHtml(tag)}">
                      #${escapeHtml(tag)}
                    </button>
                  `,
                )
                .join("")}
            </div>
            <div class="fact-actions">
              <button class="ghost-button" type="button" data-copy-link="${fact.id}" data-copy-url="${escapeHtml(factUrl)}">Копировать ссылку</button>
              ${canEdit ? `<button class="ghost-button" type="button" data-edit-fact="${fact.id}">Редактировать</button>` : ""}
            </div>
          `
      }
    </article>
  `;
}

function bindEvents() {
  document.querySelector("#toggle-details")?.addEventListener("click", () => {
    state.detailsOpen = !state.detailsOpen;
    render();
  });

  document.querySelector("#collapse-details")?.addEventListener("click", () => {
    state.detailsOpen = false;
    render();
  });

  document.querySelector("#scope")?.addEventListener("change", async (event) => {
    clearFocusFact();
    state.filters.scope = event.target.value;
    state.filters.page = 1;
    await loadDashboard();
  });

  document.querySelector("#week")?.addEventListener("change", async (event) => {
    clearFocusFact();
    state.filters.week = event.target.value || getCurrentWeek();
    state.filters.page = 1;
    await loadDashboard();
  });

  document.querySelector("#day")?.addEventListener("change", async (event) => {
    clearFocusFact();
    state.filters.day = event.target.value || getToday();
    state.filters.page = 1;
    await loadDashboard();
  });

  document.querySelector("#fact-search")?.addEventListener("input", (event) => {
    clearFocusFact();
    state.filters.query = event.target.value;
    state.filters.page = 1;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      loadDashboard();
    }, 250);
  });

  document.querySelectorAll("[data-tag]").forEach((button) => {
    button.addEventListener("click", async () => {
      clearFocusFact();
      const tag = button.dataset.tag;
      if (tag === "__all__") {
        state.filters.tags = [];
      } else if (state.filters.tags.includes(tag)) {
        state.filters.tags = state.filters.tags.filter((item) => item !== tag);
      } else {
        state.filters.tags = [...state.filters.tags, tag];
      }
      state.filters.page = 1;
      await loadDashboard();
    });
  });

  document.querySelectorAll("[data-member-filter]").forEach((button) => {
    button.addEventListener("click", async () => {
      clearFocusFact();
      const nextMemberId = button.dataset.memberFilter || "";
      state.filters.memberId = state.filters.memberId === nextMemberId ? "" : nextMemberId;
      state.filters.page = 1;
      await loadDashboard();
    });
  });

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", async () => {
      clearFocusFact();
      const nextPage = Number(button.dataset.page || state.filters.page);
      if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage === state.filters.page) {
        return;
      }
      state.filters.page = nextPage;
      await loadDashboard();
    });
  });

  bindAuthEvents();
  bindFactEvents();
  bindAdminEvents();
}

function bindAuthEvents() {
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.authMode;
      if (!nextMode || nextMode === state.authDraft.mode) {
        return;
      }
      state.authDraft.mode = nextMode;
      state.error = "";
      render();
    });
  });

  document.querySelector("#login-username")?.addEventListener("input", (event) => {
    state.authDraft.loginUsername = event.target.value;
  });

  document.querySelector("#login-password")?.addEventListener("input", (event) => {
    state.authDraft.loginPassword = event.target.value;
  });

  document.querySelector("#login-remember")?.addEventListener("change", (event) => {
    state.authDraft.loginRemember = event.target.checked;
  });

  document.querySelector("#login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await apiRequest("/api/auth/login", {
        method: "POST",
        body: {
          username: state.authDraft.loginUsername.trim(),
          password: state.authDraft.loginPassword,
          rememberMe: state.authDraft.loginRemember,
        },
      });
      state.authDraft.loginPassword = "";
      showNotice("Вход выполнен.");
      await loadDashboard();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });

  document.querySelector("#register-username")?.addEventListener("input", (event) => {
    state.authDraft.registerUsername = event.target.value;
  });

  document.querySelector("#register-name")?.addEventListener("input", (event) => {
    state.authDraft.registerName = event.target.value;
  });

  document.querySelector("#register-password")?.addEventListener("input", (event) => {
    state.authDraft.registerPassword = event.target.value;
  });

  document.querySelector("#register-remember")?.addEventListener("change", (event) => {
    state.authDraft.registerRemember = event.target.checked;
  });

  document.querySelector("#register-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await apiRequest("/api/auth/register", {
        method: "POST",
        body: {
          name: state.authDraft.registerName.trim(),
          username: state.authDraft.registerUsername.trim(),
          password: state.authDraft.registerPassword,
          rememberMe: state.authDraft.registerRemember,
        },
      });
      state.authDraft.loginUsername = state.authDraft.registerUsername.trim();
      state.authDraft.loginRemember = state.authDraft.registerRemember;
      state.authDraft.registerName = "";
      state.authDraft.registerUsername = "";
      state.authDraft.registerPassword = "";
      showNotice("Кабинет создан и вход выполнен.");
      await loadDashboard();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });

  document.querySelector("#logout-button")?.addEventListener("click", async () => {
    try {
      await apiRequest("/api/auth/logout", {
        method: "POST",
      });
      state.editingFactId = "";
      state.voice.status = "";
      state.voice.transcript = "";
      showNotice("Ты вышел из кабинета.");
      await loadDashboard();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });
}

function bindFactEvents() {
  document.querySelector("#member")?.addEventListener("change", (event) => {
    state.draft.memberId = event.target.value;
  });

  document.querySelector("#fact-text")?.addEventListener("input", (event) => {
    state.draft.text = event.target.value;
  });

  document.querySelector("#fact-tags")?.addEventListener("input", (event) => {
    state.draft.tags = event.target.value;
  });

  document.querySelector("#fill-demo")?.addEventListener("click", () => {
    const fallbackMember = state.dashboard?.members.find((member) => member.inTeam);
    state.draft.memberId = fallbackMember?.id || "";
    state.draft.text = "На стендапе снова выяснилось, что лучшие идеи команда придумывает в побочных разговорах между задачами.";
    state.draft.tags = "забавно, полезно, инсайт";
    render();
  });

  document.querySelector("#voice-capture")?.addEventListener("click", async () => {
    if (state.voice.listening) {
      activeRecognition?.stop();
      return;
    }
    await startVoiceCapture();
  });

  document.querySelector("#fact-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      memberId: state.draft.memberId,
      text: state.draft.text.trim(),
      tags: parseTags(state.draft.tags),
    };
    if (!payload.memberId || !payload.text) {
      return;
    }

    try {
      await apiRequest("/api/facts", {
        method: "POST",
        body: payload,
      });
      state.draft.text = "";
      state.draft.tags = "";
      state.detailsOpen = true;
      state.filters.page = 1;
      showNotice("Факт добавлен в копилку.");
      await loadDashboard();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });

  document.querySelectorAll("[data-edit-fact]").forEach((button) => {
    button.addEventListener("click", () => {
      const fact = state.dashboard?.facts.find((item) => item.id === button.dataset.editFact);
      if (!fact) {
        return;
      }
      state.editingFactId = fact.id;
      state.editDraft.text = fact.text;
      state.editDraft.tags = fact.tags.join(", ");
      render();
    });
  });

  document.querySelectorAll("[data-edit-text]").forEach((textarea) => {
    textarea.addEventListener("input", (event) => {
      state.editDraft.text = event.target.value;
    });
  });

  document.querySelectorAll("[data-edit-tags]").forEach((input) => {
    input.addEventListener("input", (event) => {
      state.editDraft.tags = event.target.value;
    });
  });

  document.querySelectorAll("[data-save-fact]").forEach((button) => {
    button.addEventListener("click", async () => {
      const factId = button.dataset.saveFact;
      try {
        await apiRequest(`/api/facts/${factId}`, {
          method: "PATCH",
          body: {
            text: state.editDraft.text.trim(),
            tags: parseTags(state.editDraft.tags),
          },
        });
        state.editingFactId = "";
        showNotice("Факт обновлен.");
        await loadDashboard();
      } catch (error) {
        state.error = error.message;
        render();
      }
    });
  });

  document.querySelectorAll("[data-cancel-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingFactId = "";
      state.editDraft.text = "";
      state.editDraft.tags = "";
      render();
    });
  });

  document.querySelectorAll("[data-copy-link]").forEach((button) => {
    button.addEventListener("click", async () => {
      const factUrl = decodeHtml(button.dataset.copyUrl || getFactUrl(button.dataset.copyLink));
      try {
        await copyToClipboard(factUrl);
        showNotice("Ссылка на факт скопирована.");
      } catch (_error) {
        state.error = "Не удалось скопировать ссылку.";
        render();
      }
    });
  });
}

function bindAdminEvents() {
  document.querySelectorAll("[data-member-input]").forEach((input) => {
    input.addEventListener("blur", async () => {
      const memberId = input.dataset.memberInput;
      const nextName = input.value.trim();
      const currentMember = state.dashboard?.members.find((member) => member.id === memberId);
      if (!memberId || !nextName || !currentMember || currentMember.name === nextName) {
        render();
        return;
      }

      try {
        await apiRequest(`/api/members/${memberId}`, {
          method: "PATCH",
          body: { name: nextName },
        });
        await loadDashboard();
      } catch (error) {
        state.error = error.message;
        render();
      }
    });
  });

  document.querySelectorAll("[data-toggle-member]").forEach((button) => {
    button.addEventListener("click", async () => {
      const memberId = button.dataset.toggleMember;
      const inTeam = button.dataset.inTeam === "true";
      try {
        await apiRequest(`/api/members/${memberId}`, {
          method: "PATCH",
          body: { inTeam: !inTeam },
        });
        await loadDashboard();
      } catch (error) {
        state.error = error.message;
        render();
      }
    });
  });

  document.querySelectorAll("[data-delete-member]").forEach((button) => {
    button.addEventListener("click", async () => {
      const memberId = button.dataset.deleteMember;
      const memberName = button.dataset.memberName || "этого участника";
      const confirmed = window.confirm(`Удалить ${memberName} из команды? Факты останутся в ленте.`);
      if (!confirmed) {
        return;
      }

      try {
        await apiRequest(`/api/members/${memberId}`, {
          method: "DELETE",
        });
        await loadDashboard();
      } catch (error) {
        state.error = error.message;
        render();
      }
    });
  });

  document.querySelector("#member-name")?.addEventListener("input", (event) => {
    state.adminDraft.name = event.target.value;
  });

  document.querySelector("#member-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = state.adminDraft.name.trim();
    if (!name) {
      return;
    }

    try {
      await apiRequest("/api/members", {
        method: "POST",
        body: { name },
      });
      state.adminDraft.name = "";
      await loadDashboard();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });
}

async function startVoiceCapture() {
  const SpeechRecognition = getSpeechRecognitionClass();
  if (!SpeechRecognition) {
    state.error = "В этом браузере нет встроенного распознавания речи.";
    render();
    return;
  }

  if (!state.draft.memberId) {
    state.error = "Сначала выбери участника, для которого готовится факт.";
    render();
    return;
  }

  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  let transcript = "";

  recognition.lang = "ru-RU";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.voice.listening = true;
    state.voice.loading = false;
    state.voice.status = "Слушаю. Можно говорить свободно, я соберу это в короткий черновик.";
    state.voice.transcript = "";
    render();
  };

  recognition.onresult = (event) => {
    transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim();
    state.voice.transcript = transcript;
    state.voice.status = "Распознаю речь...";
    render();
  };

  recognition.onerror = (event) => {
    activeRecognition = null;
    state.voice.listening = false;
    state.voice.loading = false;
    state.voice.status = "";
    state.error = event.error === "not-allowed" ? "Браузер не получил доступ к микрофону." : "Не удалось распознать голос.";
    render();
  };

  recognition.onend = async () => {
    activeRecognition = null;
    state.voice.listening = false;
    if (!transcript) {
      state.voice.loading = false;
      state.voice.status = "Ничего не удалось распознать. Попробуй еще раз.";
      render();
      return;
    }

    state.voice.loading = true;
    state.voice.status = "Суммаризирую в черновик...";
    render();

    try {
      const result = await apiRequest("/api/facts/summarize", {
        method: "POST",
        body: { transcript },
      });
      state.draft.text = result.summary;
      state.draft.tags = result.tags.join(", ");
      state.voice.transcript = result.transcript;
      state.voice.loading = false;
      state.voice.status = "Черновик готов. Проверь формулировку и нажми отправить, когда будешь готов.";
      showNotice("Черновик факта обновлен из голосовой заметки.");
    } catch (error) {
      state.voice.loading = false;
      state.error = error.message;
      render();
    }
  };

  recognition.start();
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Ошибка запроса.");
  }
  return payload;
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "absolute";
  helper.style.left = "-9999px";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
}

function showNotice(message) {
  state.notice = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    state.notice = "";
    render();
  }, 2200);
  render();
}

function renderMemberBadge(member) {
  if (member.deleted) {
    return '<span class="leader-status">удален</span>';
  }
  return `<span class="leader-status">${member.inTeam ? "в команде" : "не в команде"}</span>`;
}

function getFactUrl(factId) {
  const url = new URL(window.location.href);
  url.searchParams.set("fact", factId);
  return url.toString();
}

function getFactIdFromUrl() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("fact") || "";
  } catch (_error) {
    return "";
  }
}

function clearFocusFact() {
  if (!state.focusFactId) {
    return;
  }
  state.focusFactId = "";
  const url = new URL(window.location.href);
  url.searchParams.delete("fact");
  window.history.replaceState({}, "", url);
}

function maybeScrollToFocusedFact() {
  if (!state.focusFactId) {
    return;
  }
  requestAnimationFrame(() => {
    const element = document.getElementById(`fact-${state.focusFactId}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

function getSpeechRecognitionClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function parseTags(input) {
  return [...new Set(
    String(input)
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function getScopeLabel(filters) {
  if (filters.scope === "day") {
    return `фактов за ${formatDateLabel(filters.day)}`;
  }
  if (filters.scope === "week") {
    return `фактов за неделю ${formatWeekLabel(filters.week)}`;
  }
  return "фактов за все время";
}

function formatDateLabel(dateString) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(dateString));
}

function formatWeekLabel(weekValue) {
  const [yearPart, weekPart] = weekValue.split("-W");
  return `${weekPart} / ${yearPart}`;
}

function getCurrentWeek() {
  return getWeekValueForDate(new Date());
}

function getWeekValueForDate(date) {
  const target = new Date(date);
  const day = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - day + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target - firstThursday;
  const week = 1 + Math.round(diff / 604800000);
  return `${target.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function getToday() {
  return formatDateInputValue(new Date());
}

function formatDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyDashboard() {
  return {
    totalFacts: 0,
    filteredTotal: 0,
    tags: [],
    memberFilter: null,
    facts: [],
    members: [],
    leaderboard: [],
    currentUser: null,
    focusFactId: "",
    pagination: {
      page: 1,
      totalPages: 1,
      totalItems: 0,
      startItem: 0,
      endItem: 0,
    },
  };
}

function decodeHtml(value) {
  const element = document.createElement("textarea");
  element.innerHTML = value;
  return element.value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
