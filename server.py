import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT_DIR = Path(__file__).resolve().parent
STATIC_DIR = ROOT_DIR
DB_PATH = Path(os.environ.get("VAULTY_DB_PATH", ROOT_DIR / "data" / "vaulty.db"))
HOST = os.environ.get("VAULTY_HOST", "0.0.0.0")
PORT = int(os.environ.get("VAULTY_PORT", "8000"))
PAGE_SIZE_DEFAULT = 30
SESSION_COOKIE_NAME = "vaulty_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30
PASSWORD_ITERATIONS = 240_000

MEMBER_COLORS = ["#d2693c", "#5d734b", "#a05c2f", "#587a90", "#9f6c7d", "#8b7a42"]
PURGE_MEMBER_IDS = {"m1", "m2", "m3", "m4"}
MIGRATION_PURGE_LEGACY_SEED_DATA = "purge_legacy_seed_data_20260326_v2"

STOPWORDS = {
    "а", "без", "более", "бы", "был", "была", "были", "было", "быть", "в", "вам", "вас", "во",
    "вот", "все", "всё", "вы", "где", "да", "для", "до", "его", "ее", "её", "если", "есть",
    "еще", "ещё", "же", "за", "здесь", "и", "из", "или", "им", "их", "к", "как", "ко", "когда",
    "который", "которая", "которые", "кто", "ли", "либо", "мне", "можно", "мы", "на", "над",
    "надо", "наш", "не", "него", "нее", "неё", "нет", "но", "ну", "о", "об", "один", "она",
    "они", "оно", "от", "очень", "по", "под", "после", "потому", "почти", "при", "про", "раз",
    "с", "сам", "сама", "свои", "свой", "себе", "себя", "со", "так", "там", "те", "тем", "то",
    "того", "тоже", "только", "том", "ты", "у", "уже", "хотя", "чего", "чей", "чем", "что",
    "чтобы", "эта", "эти", "это", "этот", "я", "короче", "типа", "как бы", "ну вот",
}

KEYWORD_TAGS = {
    "архитект": "архитектура",
    "cron": "cron",
    "ретро": "ретро",
    "дейли": "дейли",
    "стендап": "дейли",
    "команд": "команда",
    "баг": "баги",
    "инсайт": "инсайт",
    "мем": "мем",
    "полез": "полезно",
    "смеш": "забавно",
    "забав": "забавно",
    "кринж": "кринж",
    "созвон": "созвон",
}


def utc_now():
    return datetime.now(timezone.utc)


def utc_now_iso():
    return utc_now().isoformat().replace("+00:00", "Z")


def parse_iso_datetime(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def ensure_column(cursor, table_name, column_name, definition):
    columns = {row["name"] for row in cursor.execute(f"PRAGMA table_info({table_name})").fetchall()}
    if column_name not in columns:
        cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")


def ensure_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_connection() as connection:
        cursor = connection.cursor()
        cursor.executescript(
            """
            CREATE TABLE IF NOT EXISTS members (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                in_team INTEGER NOT NULL DEFAULT 1,
                deleted INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS facts (
                id TEXT PRIMARY KEY,
                member_id TEXT NOT NULL,
                member_name_snapshot TEXT NOT NULL,
                member_color_snapshot TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS fact_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fact_id TEXT NOT NULL,
                tag TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS fact_likes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fact_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(fact_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                member_id TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_facts_created_at ON facts(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_fact_tags_fact_id ON fact_tags(fact_id);
            CREATE INDEX IF NOT EXISTS idx_fact_tags_tag ON fact_tags(tag);
            CREATE INDEX IF NOT EXISTS idx_fact_likes_fact_id ON fact_likes(fact_id);
            CREATE INDEX IF NOT EXISTS idx_fact_likes_user_id ON fact_likes(user_id);
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            """
        )

        ensure_column(cursor, "facts", "author_id", "TEXT")
        ensure_column(cursor, "facts", "author_name_snapshot", "TEXT")
        ensure_column(cursor, "facts", "updated_at", "TEXT")
        ensure_column(cursor, "facts", "source_transcript", "TEXT DEFAULT ''")
        ensure_column(cursor, "users", "display_name", "TEXT NOT NULL DEFAULT ''")

        cursor.execute(
            """
            UPDATE facts
            SET author_id = COALESCE(author_id, member_id),
                author_name_snapshot = COALESCE(author_name_snapshot, member_name_snapshot),
                updated_at = COALESCE(updated_at, created_at),
                source_transcript = COALESCE(source_transcript, '')
            """
        )
        cursor.execute(
            """
            UPDATE users
            SET display_name = COALESCE(NULLIF(TRIM(display_name), ''), username)
            """
        )

        run_migrations(cursor)
        connection.commit()


def run_migrations(cursor):
    already_applied = cursor.execute(
        "SELECT value FROM app_meta WHERE key = ?",
        (MIGRATION_PURGE_LEGACY_SEED_DATA,),
    ).fetchone()
    if already_applied:
        return

    fact_ids = [
        row["id"]
        for row in cursor.execute(
            """
            SELECT id
            FROM facts
            WHERE member_id IN (?, ?, ?, ?)
            """,
            tuple(sorted(PURGE_MEMBER_IDS)),
        ).fetchall()
    ]
    if fact_ids:
        placeholders = ", ".join(["?"] * len(fact_ids))
        cursor.execute(f"DELETE FROM fact_tags WHERE fact_id IN ({placeholders})", fact_ids)
        cursor.execute(f"DELETE FROM facts WHERE id IN ({placeholders})", fact_ids)

    cursor.execute("DELETE FROM users WHERE member_id IN (?, ?, ?, ?)", tuple(sorted(PURGE_MEMBER_IDS)))
    cursor.execute("DELETE FROM members WHERE id IN (?, ?, ?, ?)", tuple(sorted(PURGE_MEMBER_IDS)))
    cursor.execute(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)",
        (MIGRATION_PURGE_LEGACY_SEED_DATA, utc_now_iso()),
    )


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return "$".join(
        [
            "pbkdf2_sha256",
            str(PASSWORD_ITERATIONS),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        ]
    )


def verify_password(password, stored_value):
    try:
        algorithm, iterations_text, salt_b64, digest_b64 = stored_value.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64.encode("ascii"))
        stored_digest = base64.b64decode(digest_b64.encode("ascii"))
        calculated_digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            int(iterations_text),
        )
        return hmac.compare_digest(stored_digest, calculated_digest)
    except Exception:
        return False


def normalize_tag(tag):
    return str(tag).strip().lower()


def normalize_username(username):
    value = str(username).strip().lower()
    if not re.fullmatch(r"[a-z0-9_.-]{3,32}", value):
        raise ValueError("Логин должен быть длиной 3-32 символа и состоять из латиницы, цифр, точки, дефиса или нижнего подчеркивания.")
    return value


def normalize_display_name(display_name):
    value = re.sub(r"\s+", " ", str(display_name).strip())
    if len(value) < 2 or len(value) > 48:
        raise ValueError("Имя должно быть длиной 2-48 символов.")
    return value


def get_week_value(target_datetime):
    iso_year, iso_week, _ = target_datetime.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def format_fact_date(value):
    target = parse_iso_datetime(value).astimezone()
    months = [
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ]
    return f"{target.day} {months[target.month - 1]}, {target.hour:02d}:{target.minute:02d}"


def get_members(connection, include_deleted=True):
    where_clause = "" if include_deleted else "WHERE deleted = 0"
    rows = connection.execute(
        f"""
        SELECT
            members.id,
            members.name,
            members.color,
            members.in_team,
            members.deleted,
            COUNT(facts.id) AS fact_count
        FROM members
        LEFT JOIN facts ON facts.member_id = members.id
        {where_clause}
        GROUP BY members.id
        ORDER BY members.created_at ASC, members.rowid ASC
        """
    ).fetchall()

    return [
        {
            "id": row["id"],
            "name": row["name"],
            "color": row["color"],
            "inTeam": bool(row["in_team"]),
            "deleted": bool(row["deleted"]),
            "factCount": row["fact_count"],
        }
        for row in rows
    ]


def serialize_current_user(row):
    if row is None:
        return None
    return {
        "id": row["id"],
        "name": row["display_name"] or row["username"],
        "username": row["username"],
        "legacyMemberId": row["member_id"],
    }


def get_facts(connection, current_user=None):
    rows = connection.execute(
        """
        SELECT
            facts.id,
            facts.member_id,
            facts.member_name_snapshot,
            facts.member_color_snapshot,
            facts.author_id,
            facts.author_name_snapshot,
            facts.text,
            facts.created_at,
            facts.updated_at,
            facts.source_transcript,
            members.in_team AS current_in_team,
            members.deleted AS current_deleted,
            GROUP_CONCAT(fact_tags.tag, '||') AS tags
        FROM facts
        LEFT JOIN members ON members.id = facts.member_id
        LEFT JOIN fact_tags ON fact_tags.fact_id = facts.id
        GROUP BY facts.id
        ORDER BY facts.created_at DESC
        """
    ).fetchall()

    like_counts = {
        row["fact_id"]: row["like_count"]
        for row in connection.execute(
            """
            SELECT fact_id, COUNT(*) AS like_count
            FROM fact_likes
            GROUP BY fact_id
            """
        ).fetchall()
    }
    liked_fact_ids = set()
    if current_user is not None:
        liked_fact_ids = {
            row["fact_id"]
            for row in connection.execute(
                "SELECT fact_id FROM fact_likes WHERE user_id = ?",
                (current_user["id"],),
            ).fetchall()
        }

    facts = []
    for row in rows:
        updated_at = row["updated_at"] or row["created_at"]
        tags = [] if row["tags"] is None else sorted(set(filter(None, row["tags"].split("||"))))
        facts.append(
            {
                "id": row["id"],
                "memberId": row["member_id"],
                "memberName": row["member_name_snapshot"],
                "memberColor": row["member_color_snapshot"],
                "authorId": row["author_id"] or row["member_id"],
                "authorName": row["author_name_snapshot"] or row["member_name_snapshot"],
                "text": row["text"],
                "createdAt": row["created_at"],
                "createdAtLabel": format_fact_date(row["created_at"]),
                "updatedAt": updated_at,
                "updatedAtLabel": format_fact_date(updated_at),
                "edited": updated_at != row["created_at"],
                "tags": tags,
                "likesCount": like_counts.get(row["id"], 0),
                "likedByCurrentUser": row["id"] in liked_fact_ids,
                "memberDeleted": bool(row["current_deleted"]) if row["current_deleted"] is not None else True,
                "memberInTeam": bool(row["current_in_team"]) if row["current_in_team"] is not None else False,
            }
        )
    return facts


def filter_facts(facts, scope, day_value, week_value, member_ids, tags, query):
    normalized_query = query.strip().lower()
    selected_tags = {normalize_tag(tag) for tag in tags if normalize_tag(tag)}
    selected_member_ids = {member_id for member_id in member_ids if member_id}
    filtered = []

    for fact in facts:
        if selected_member_ids and fact["memberId"] not in selected_member_ids:
            continue
        target_datetime = parse_iso_datetime(fact["createdAt"]).astimezone()
        if scope == "day" and target_datetime.date().isoformat() != day_value:
            continue
        if scope == "week" and get_week_value(target_datetime) != week_value:
            continue
        if selected_tags and not selected_tags.intersection(set(fact["tags"])):
            continue
        if normalized_query:
            haystack = " ".join([fact["text"], fact["memberName"], fact["authorName"], " ".join(fact["tags"])]).lower()
            if normalized_query not in haystack:
                continue
        filtered.append(fact)

    return filtered


def build_leaderboard(members, facts):
    counts = {}
    by_member = {member["id"]: member for member in members}

    for fact in facts:
        counts[fact["memberId"]] = counts.get(fact["memberId"], 0) + 1
        if fact["memberId"] not in by_member:
            by_member[fact["memberId"]] = {
                "id": fact["memberId"],
                "name": fact["memberName"],
                "color": fact["memberColor"],
                "inTeam": False,
                "deleted": True,
                "factCount": counts[fact["memberId"]],
            }

    max_count = max(counts.values(), default=0)
    leaderboard = []
    for member in by_member.values():
        count = counts.get(member["id"], 0)
        leaderboard.append(
            {
                "id": member["id"],
                "name": member["name"],
                "color": member["color"],
                "count": count,
                "inTeam": member["inTeam"],
                "deleted": member["deleted"],
                "width": max((count / max_count) * 100, 12 if count else 0) if max_count else 0,
            }
        )

    leaderboard.sort(key=lambda item: (-item["count"], item["deleted"], not item["inTeam"], item["name"].lower()))
    return leaderboard


def paginate_items(items, page, page_size):
    total_items = len(items)
    total_pages = max((total_items + page_size - 1) // page_size, 1)
    current_page = min(max(page, 1), total_pages)
    start_index = (current_page - 1) * page_size
    end_index = start_index + page_size
    page_items = items[start_index:end_index]
    return page_items, {
        "page": current_page,
        "totalPages": total_pages,
        "totalItems": total_items,
        "startItem": start_index + 1 if total_items else 0,
        "endItem": min(end_index, total_items),
    }


def get_focus_page(items, fact_id, page_size):
    for index, item in enumerate(items):
        if item["id"] == fact_id:
            return (index // page_size) + 1
    return 1


def resolve_member_filters(members, facts, member_ids):
    if not member_ids:
        return []

    resolved = []
    seen_ids = set()
    for member_id in member_ids:
        if not member_id or member_id in seen_ids:
            continue

        match = next((member for member in members if member["id"] == member_id), None)
        if match:
            resolved.append({"id": match["id"], "name": match["name"]})
            seen_ids.add(member_id)
            continue

        fact_match = next((fact for fact in facts if fact["memberId"] == member_id), None)
        if fact_match:
            resolved.append({"id": fact_match["memberId"], "name": fact_match["memberName"]})
            seen_ids.add(member_id)

    return resolved


def dashboard_payload(query_params, current_user):
    if current_user is None:
        return {
            "totalFacts": 0,
            "filteredTotal": 0,
            "tags": [],
            "memberFilters": [],
            "facts": [],
            "members": [],
            "leaderboard": [],
            "currentUser": None,
            "focusFactId": "",
            "pagination": {
                "page": 1,
                "totalPages": 1,
                "totalItems": 0,
                "startItem": 0,
                "endItem": 0,
            },
        }

    scope = query_params.get("scope", ["total"])[0]
    week = query_params.get("week", [get_week_value(datetime.now().astimezone())])[0]
    day_value = query_params.get("day", [date.today().isoformat()])[0]
    member_ids = query_params.get("memberId", [])
    tags = query_params.get("tag", [])
    query = query_params.get("q", [""])[0]
    focus_fact_id = query_params.get("focusFactId", [""])[0]
    page = int(query_params.get("page", ["1"])[0] or 1)
    page_size = int(query_params.get("pageSize", [str(PAGE_SIZE_DEFAULT)])[0] or PAGE_SIZE_DEFAULT)

    with get_connection() as connection:
        members = get_members(connection, include_deleted=False)
        all_members = get_members(connection, include_deleted=True)
        facts = get_facts(connection, current_user)

    if focus_fact_id and any(fact["id"] == focus_fact_id for fact in facts):
        filtered_facts = facts
        page = get_focus_page(filtered_facts, focus_fact_id, page_size)
    else:
        filtered_facts = filter_facts(facts, scope, day_value, week, member_ids, tags, query)

    page_items, pagination = paginate_items(filtered_facts, page, page_size)
    leaderboard = build_leaderboard(all_members, filtered_facts)
    tags_list = sorted({tag for fact in facts for tag in fact["tags"]})
    member_filters = resolve_member_filters(all_members, facts, member_ids)

    return {
        "totalFacts": len(facts),
        "filteredTotal": len(filtered_facts),
        "tags": tags_list,
        "memberFilters": member_filters,
        "facts": page_items,
        "members": members,
        "leaderboard": leaderboard,
        "currentUser": serialize_current_user(current_user),
        "focusFactId": focus_fact_id if any(fact["id"] == focus_fact_id for fact in facts) else "",
        "pagination": pagination,
    }


def get_member_for_fact(connection, member_id):
    member = connection.execute(
        """
        SELECT id, name, color, in_team, deleted
        FROM members
        WHERE id = ?
        """,
        (member_id,),
    ).fetchone()
    if member is None or member["deleted"] or not member["in_team"]:
        raise LookupError("Можно добавлять факты только для участников, которые сейчас в команде.")
    return member


def replace_fact_tags(connection, fact_id, tags):
    connection.execute("DELETE FROM fact_tags WHERE fact_id = ?", (fact_id,))
    connection.executemany(
        "INSERT INTO fact_tags (fact_id, tag) VALUES (?, ?)",
        [(fact_id, tag) for tag in tags],
    )


def get_request_token(handler):
    raw_cookie = handler.headers.get("Cookie", "")
    if not raw_cookie:
        return ""
    cookie = cookies.SimpleCookie()
    cookie.load(raw_cookie)
    return cookie.get(SESSION_COOKIE_NAME).value if cookie.get(SESSION_COOKIE_NAME) else ""


def get_current_user(connection, token):
    if not token:
        return None

    row = connection.execute(
        """
        SELECT
            users.id,
            users.member_id,
            users.display_name,
            users.username,
            sessions.expires_at
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = ?
        """,
        (token,),
    ).fetchone()
    if row is None:
        return None

    if parse_iso_datetime(row["expires_at"]) < utc_now():
        connection.execute("DELETE FROM sessions WHERE token = ?", (token,))
        connection.commit()
        return None

    return row


def create_session(connection, user_id):
    token = secrets.token_urlsafe(32)
    created_at = utc_now_iso()
    expires_at = (utc_now() + timedelta(seconds=SESSION_MAX_AGE)).isoformat().replace("+00:00", "Z")
    connection.execute(
        "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (token, user_id, expires_at, created_at),
    )
    return token


def clear_session(connection, token):
    if token:
        connection.execute("DELETE FROM sessions WHERE token = ?", (token,))


def build_session_cookie(token, remember_me):
    morsel = cookies.SimpleCookie()
    morsel[SESSION_COOKIE_NAME] = token
    morsel[SESSION_COOKIE_NAME]["path"] = "/"
    morsel[SESSION_COOKIE_NAME]["httponly"] = True
    morsel[SESSION_COOKIE_NAME]["samesite"] = "Lax"
    if remember_me:
        morsel[SESSION_COOKIE_NAME]["max-age"] = str(SESSION_MAX_AGE)
    return morsel.output(header="").strip()


def build_expired_session_cookie():
    morsel = cookies.SimpleCookie()
    morsel[SESSION_COOKIE_NAME] = ""
    morsel[SESSION_COOKIE_NAME]["path"] = "/"
    morsel[SESSION_COOKIE_NAME]["max-age"] = "0"
    morsel[SESSION_COOKIE_NAME]["expires"] = "Thu, 01 Jan 1970 00:00:00 GMT"
    morsel[SESSION_COOKIE_NAME]["httponly"] = True
    morsel[SESSION_COOKIE_NAME]["samesite"] = "Lax"
    return morsel.output(header="").strip()


def require_auth(connection, handler):
    user = get_current_user(connection, get_request_token(handler))
    if user is None:
        raise PermissionError("Нужно войти в личный кабинет.")
    return user


def register_user(payload):
    display_name = normalize_display_name(payload.get("name", ""))
    username = normalize_username(payload.get("username", ""))
    password = str(payload.get("password", ""))
    if len(password) < 6:
        raise ValueError("Пароль должен быть не короче 6 символов.")

    with get_connection() as connection:
        existing_username = connection.execute(
            "SELECT id FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if existing_username:
            raise ValueError("Такой логин уже занят.")

        user_id = str(uuid.uuid4())
        legacy_member_id = f"user:{user_id}"
        connection.execute(
            """
            INSERT INTO users (id, member_id, display_name, username, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user_id, legacy_member_id, display_name, username, hash_password(password), utc_now_iso()),
        )
        token = create_session(connection, user_id)
        connection.commit()

        user = connection.execute(
            """
            SELECT users.id, users.member_id, users.display_name, users.username
            FROM users
            WHERE users.id = ?
            """,
            (user_id,),
        ).fetchone()

    return serialize_current_user(user), token


def login_user(payload):
    username = normalize_username(payload.get("username", ""))
    password = str(payload.get("password", ""))

    with get_connection() as connection:
        user = connection.execute(
            """
            SELECT
                users.id,
                users.member_id,
                users.display_name,
                users.username,
                users.password_hash
            FROM users
            WHERE users.username = ?
            """,
            (username,),
        ).fetchone()
        if user is None or not verify_password(password, user["password_hash"]):
            raise PermissionError("Неверный логин или пароль.")

        token = create_session(connection, user["id"])
        connection.commit()

    return serialize_current_user(user), token


def logout_user(handler):
    token = get_request_token(handler)
    with get_connection() as connection:
        clear_session(connection, token)
        connection.commit()


def create_member(payload):
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValueError("Имя участника обязательно.")

    with get_connection() as connection:
        color = MEMBER_COLORS[connection.execute("SELECT COUNT(*) FROM members").fetchone()[0] % len(MEMBER_COLORS)]
        member_id = str(uuid.uuid4())
        connection.execute(
            """
            INSERT INTO members (id, name, color, in_team, deleted, created_at)
            VALUES (?, ?, ?, 1, 0, ?)
            """,
            (member_id, name, color, utc_now_iso()),
        )
        connection.commit()

    return {"id": member_id, "name": name, "color": color}


def update_member(member_id, payload):
    with get_connection() as connection:
        member = connection.execute(
            "SELECT id, name, in_team, deleted FROM members WHERE id = ?",
            (member_id,),
        ).fetchone()
        if member is None or member["deleted"]:
            raise LookupError("Участник не найден.")

        next_name = str(payload.get("name", member["name"])).strip() or member["name"]
        in_team = payload.get("inTeam")
        next_in_team = member["in_team"] if in_team is None else int(bool(in_team))

        connection.execute(
            "UPDATE members SET name = ?, in_team = ? WHERE id = ?",
            (next_name, next_in_team, member_id),
        )
        connection.commit()

    return {"id": member_id, "name": next_name, "inTeam": bool(next_in_team)}


def delete_member(member_id):
    with get_connection() as connection:
        member = connection.execute(
            "SELECT id FROM members WHERE id = ? AND deleted = 0",
            (member_id,),
        ).fetchone()
        if member is None:
            raise LookupError("Участник не найден.")

        connection.execute("UPDATE members SET deleted = 1, in_team = 0 WHERE id = ?", (member_id,))
        connection.commit()

    return {"deleted": True}


def create_fact(payload, current_user):
    member_id = str(payload.get("memberId", "")).strip()
    text = str(payload.get("text", "")).strip()
    source_transcript = str(payload.get("sourceTranscript", "")).strip()
    tags = sorted({normalize_tag(tag) for tag in payload.get("tags", []) if normalize_tag(tag)})
    if not member_id or not text:
        raise ValueError("Для факта нужны участник и текст.")

    with get_connection() as connection:
        member = get_member_for_fact(connection, member_id)
        fact_id = str(uuid.uuid4())
        created_at = utc_now_iso()
        connection.execute(
            """
            INSERT INTO facts (
                id,
                member_id,
                member_name_snapshot,
                member_color_snapshot,
                author_id,
                author_name_snapshot,
                text,
                created_at,
                updated_at,
                source_transcript
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fact_id,
                member["id"],
                member["name"],
                member["color"],
                current_user["id"],
                current_user["username"],
                text,
                created_at,
                created_at,
                source_transcript,
            ),
        )
        replace_fact_tags(connection, fact_id, tags)
        connection.commit()

    return {"id": fact_id, "createdAt": created_at}


def update_fact(fact_id, payload, current_user):
    text = str(payload.get("text", "")).strip()
    tags = sorted({normalize_tag(tag) for tag in payload.get("tags", []) if normalize_tag(tag)})
    if not text:
        raise ValueError("Для редактирования нужен текст факта.")

    with get_connection() as connection:
        fact = connection.execute(
            "SELECT id, author_id FROM facts WHERE id = ?",
            (fact_id,),
        ).fetchone()
        if fact is None:
            raise LookupError("Факт не найден.")
        allowed_author_ids = {current_user["id"], current_user["member_id"]}
        if fact["author_id"] not in allowed_author_ids:
            raise PermissionError("Редактировать факт может только тот, кто его добавил.")

        updated_at = utc_now_iso()
        connection.execute(
            "UPDATE facts SET text = ?, updated_at = ? WHERE id = ?",
            (text, updated_at, fact_id),
        )
        replace_fact_tags(connection, fact_id, tags)
        connection.commit()

    return {"id": fact_id, "updatedAt": updated_at}


def set_fact_like(fact_id, current_user, liked):
    with get_connection() as connection:
        fact = connection.execute("SELECT id FROM facts WHERE id = ?", (fact_id,)).fetchone()
        if fact is None:
            raise LookupError("Факт не найден.")

        if liked:
            connection.execute(
                """
                INSERT OR IGNORE INTO fact_likes (fact_id, user_id, created_at)
                VALUES (?, ?, ?)
                """,
                (fact_id, current_user["id"], utc_now_iso()),
            )
        else:
            connection.execute(
                "DELETE FROM fact_likes WHERE fact_id = ? AND user_id = ?",
                (fact_id, current_user["id"]),
            )

        like_count = connection.execute(
            "SELECT COUNT(*) AS like_count FROM fact_likes WHERE fact_id = ?",
            (fact_id,),
        ).fetchone()["like_count"]
        connection.commit()

    return {"id": fact_id, "likesCount": like_count, "likedByCurrentUser": liked}


def cleanup_text(text):
    compact = re.sub(r"\s+", " ", text).strip()
    compact = re.sub(r"\s*([,.;:!?])\s*", r"\1 ", compact)
    compact = re.sub(r"\s+", " ", compact).strip(" ,.;:-")
    return compact


def shorten(text, max_length=180):
    if len(text) <= max_length:
        return text
    trimmed = text[:max_length].rsplit(" ", 1)[0].strip()
    return f"{trimmed}…"


def summarize_transcript(transcript):
    raw = cleanup_text(transcript)
    if not raw:
        raise ValueError("Пустую диктовку нельзя превратить в факт.")

    parts = [cleanup_text(part) for part in re.split(r"[.!?\n]+", raw) if cleanup_text(part)]
    if not parts:
        parts = [raw]

    summary = next((part for part in parts if len(part.split()) >= 5), parts[0])
    if len(summary) < 70 and len(parts) > 1:
        summary = f"{summary}. {parts[1]}"
    if summary:
        summary = summary[:1].upper() + summary[1:]
    summary = shorten(summary)

    lower_text = raw.lower()
    tags = []
    for key, tag in KEYWORD_TAGS.items():
        if key in lower_text and tag not in tags:
            tags.append(tag)

    words = re.findall(r"[a-zA-Zа-яА-ЯёЁ0-9-]{4,}", lower_text)
    for word in words:
        if word in STOPWORDS or word in tags:
            continue
        tags.append(word)
        if len(tags) >= 4:
            break

    if not tags:
        tags = ["инсайт"]

    return {"summary": summary, "tags": tags[:4], "transcript": raw}


class VaultyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path == "/api/dashboard":
            return self.handle_dashboard(parsed_url)
        if parsed_url.path == "/health":
            return self.send_json(200, {"ok": True})
        return self.serve_static(parsed_url.path)

    def do_POST(self):
        parsed_url = urlparse(self.path)
        try:
            payload = self.read_json()

            if parsed_url.path == "/api/auth/register":
                user, token = register_user(payload)
                remember_me = bool(payload.get("rememberMe"))
                return self.send_json(201, {"user": user}, headers=[("Set-Cookie", build_session_cookie(token, remember_me))])

            if parsed_url.path == "/api/auth/login":
                user, token = login_user(payload)
                remember_me = bool(payload.get("rememberMe"))
                return self.send_json(200, {"user": user}, headers=[("Set-Cookie", build_session_cookie(token, remember_me))])

            if parsed_url.path == "/api/auth/logout":
                logout_user(self)
                return self.send_json(200, {"ok": True}, headers=[("Set-Cookie", build_expired_session_cookie())])

            if parsed_url.path == "/api/facts/summarize":
                with get_connection() as connection:
                    require_auth(connection, self)
                return self.send_json(200, summarize_transcript(payload.get("transcript", "")))

            if parsed_url.path == "/api/facts":
                with get_connection() as connection:
                    current_user = require_auth(connection, self)
                return self.send_json(201, create_fact(payload, current_user))

            if parsed_url.path.startswith("/api/facts/") and parsed_url.path.endswith("/like"):
                with get_connection() as connection:
                    current_user = require_auth(connection, self)
                fact_id = parsed_url.path.split("/")[3]
                return self.send_json(200, set_fact_like(fact_id, current_user, True))

            if parsed_url.path == "/api/members":
                with get_connection() as connection:
                    require_auth(connection, self)
                return self.send_json(201, create_member(payload))

            return self.send_json(404, {"error": "Маршрут не найден."})
        except ValueError as error:
            return self.send_json(400, {"error": str(error)})
        except LookupError as error:
            return self.send_json(404, {"error": str(error)})
        except PermissionError as error:
            return self.send_json(401, {"error": str(error)})
        except Exception:
            return self.send_json(500, {"error": "Не удалось обработать запрос."})

    def do_PATCH(self):
        parsed_url = urlparse(self.path)
        try:
            payload = self.read_json()

            if parsed_url.path.startswith("/api/members/"):
                with get_connection() as connection:
                    require_auth(connection, self)
                member_id = parsed_url.path.rsplit("/", 1)[-1]
                return self.send_json(200, update_member(member_id, payload))

            if parsed_url.path.startswith("/api/facts/"):
                with get_connection() as connection:
                    current_user = require_auth(connection, self)
                fact_id = parsed_url.path.rsplit("/", 1)[-1]
                return self.send_json(200, update_fact(fact_id, payload, current_user))

            return self.send_json(404, {"error": "Маршрут не найден."})
        except ValueError as error:
            return self.send_json(400, {"error": str(error)})
        except LookupError as error:
            return self.send_json(404, {"error": str(error)})
        except PermissionError as error:
            return self.send_json(401, {"error": str(error)})
        except Exception:
            return self.send_json(500, {"error": "Не удалось обновить запись."})

    def do_DELETE(self):
        parsed_url = urlparse(self.path)
        try:
            if parsed_url.path.startswith("/api/facts/") and parsed_url.path.endswith("/like"):
                with get_connection() as connection:
                    current_user = require_auth(connection, self)
                fact_id = parsed_url.path.split("/")[3]
                return self.send_json(200, set_fact_like(fact_id, current_user, False))

            if not parsed_url.path.startswith("/api/members/"):
                return self.send_json(404, {"error": "Маршрут не найден."})

            with get_connection() as connection:
                require_auth(connection, self)
            member_id = parsed_url.path.rsplit("/", 1)[-1]
            return self.send_json(200, delete_member(member_id))
        except LookupError as error:
            return self.send_json(404, {"error": str(error)})
        except PermissionError as error:
            return self.send_json(401, {"error": str(error)})
        except Exception:
            return self.send_json(500, {"error": "Не удалось удалить участника."})

    def handle_dashboard(self, parsed_url):
        try:
            with get_connection() as connection:
                current_user = get_current_user(connection, get_request_token(self))
            payload = dashboard_payload(parse_qs(parsed_url.query), current_user)
            return self.send_json(200, payload)
        except Exception:
            return self.send_json(500, {"error": "Не удалось загрузить дашборд."})

    def serve_static(self, request_path):
        target_path = request_path or "/"
        if target_path == "/":
            target_path = "/index.html"

        file_path = (STATIC_DIR / target_path.lstrip("/")).resolve()
        if STATIC_DIR not in file_path.parents and file_path != STATIC_DIR / "index.html":
            return self.send_json(403, {"error": "Доступ запрещен."})

        if not file_path.exists() or not file_path.is_file():
            file_path = STATIC_DIR / "index.html"

        mime_type, _ = mimetypes.guess_type(file_path.name)
        content_type = mime_type or "application/octet-stream"
        content = file_path.read_bytes()

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def read_json(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_payload = self.rfile.read(content_length) if content_length else b"{}"
        return json.loads(raw_payload.decode("utf-8"))

    def send_json(self, status_code, payload, headers=None):
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        for header_name, header_value in headers or []:
            self.send_header(header_name, header_value)
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format_string, *args):
        return


def run():
    ensure_database()
    server = ThreadingHTTPServer((HOST, PORT), VaultyHandler)
    print(f"Vaulty server is running on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    run()
