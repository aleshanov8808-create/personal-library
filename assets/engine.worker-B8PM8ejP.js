var e=`"""Детерминированное ядро школы: проверка ответов и кода, TeacherController.

Только стандартная библиотека Python. Одно и то же ядро работает в браузере
(Pyodide) и в backend. Ядро не обращается к сети, файлам и моделям.
"""

from .controller import start_state, step
from .course import course_progress, course_step, start_course_state
from .runner import run_snippet

__all__ = ["start_state", "step", "start_course_state", "course_step", "course_progress", "run_snippet"]
`,t=`"""Проверка кода ученика без запуска: только разбор через ast.

Три слоя: 1) синтаксис, 2) структура (только то, что ученик уже проходил),
3) педагогическая семантика (что требует задание). Находится одна проблема
за раз: новичку понятнее разбирать ошибки по очереди.
"""

from __future__ import annotations

import ast
import re
from typing import Any

from .normalize import normalize

PLACEHOLDER = re.compile(r"^_+$")


def _code_lines(code: str) -> list[str]:
    return [ln for ln in code.splitlines() if ln.strip() and not ln.strip().startswith("#")]


def _same_code(a: str, b: str) -> bool:
    return normalize(a, "code") == normalize(b, "code") or [x.strip() for x in _code_lines(a)] == [
        x.strip() for x in _code_lines(b)
    ]


def parse_program(code: str) -> tuple[list[ast.stmt] | None, str | None]:
    """Возвращает (операторы, id проблемы). Допустимы только присваивания и print."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None, "syntax_error"
    except (ValueError, RecursionError):
        return None, "syntax_error"
    for node in tree.body:
        if isinstance(node, ast.Assign):
            if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
                return None, "not_learned_yet"
            if not _simple_value(node.value):
                return None, "not_learned_yet"
        elif isinstance(node, ast.Expr) and _is_print(node.value):
            pass
        else:
            return None, "not_learned_yet"
    return tree.body, None


def _simple_value(node: ast.expr) -> bool:
    if isinstance(node, ast.Name):
        return True
    return isinstance(node, ast.Constant) and type(node.value) in (str, int)


def _is_print(node: ast.expr) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "print"
        and len(node.args) == 1
        and not node.keywords
        and _simple_value(node.args[0])
    )


def check_code(
    code: str,
    rules: list[dict[str, Any]],
    max_lines: int,
    starter: str | None = None,
) -> dict[str, Any]:
    """Результат: {"ok": bool, "issue": id | None, "name": имя из правила | None}."""

    def fail(issue: str, name: str | None = None) -> dict[str, Any]:
        return {"ok": False, "issue": issue, "name": name}

    lines = _code_lines(code)
    if not lines:
        return fail("unchanged_starter" if starter else "missing_assignment", rules[0]["name"] if rules else None)
    if starter is not None and _same_code(code, starter):
        return fail("unchanged_starter")

    body, problem = parse_program(code)
    if problem:
        return fail(problem)
    if len(lines) > max_lines:
        return fail("too_many_lines")
    assert body is not None

    assigns: dict[str, ast.expr] = {}
    printed: list[ast.expr] = []
    defined_before_print: dict[str, bool] = {}
    for node in body:
        if isinstance(node, ast.Assign):
            assigns[node.targets[0].id] = node.value  # type: ignore[union-attr]
        else:
            arg = node.value.args[0]  # type: ignore[attr-defined]
            printed.append(arg)
            if isinstance(arg, ast.Name):
                defined_before_print[arg.id] = arg.id in assigns

    for rule in rules:
        name = rule["name"]
        if rule["kind"] == "assign":
            if name not in assigns:
                return fail("wrong_variable_name" if assigns else "missing_assignment", name)
            value = assigns[name]
            if isinstance(value, ast.Name):
                if rule["value_type"] == "str":
                    return fail("missing_quotes", name)
                return fail("not_learned_yet", name)
            assert isinstance(value, ast.Constant)
            v = value.value
            if rule["value_type"] == "str":
                if isinstance(v, int):
                    return fail("number_instead_of_string", name)
                if PLACEHOLDER.match(v):
                    return fail("unchanged_starter", name)
                if rule.get("non_empty") and not v.strip():
                    return fail("empty_text", name)
            else:
                if isinstance(v, str):
                    return fail("string_instead_of_number", name)
                lo, hi = rule.get("int_min"), rule.get("int_max")
                if (lo is not None and v < lo) or (hi is not None and v > hi):
                    return fail("number_out_of_range", name)
        else:  # print
            if not printed:
                return fail("missing_print", name)
            matched = [a for a in printed if isinstance(a, ast.Name) and a.id == name]
            if matched:
                if not defined_before_print.get(name, False):
                    return fail("missing_assignment", name)
                continue
            if any(isinstance(a, ast.Constant) and isinstance(a.value, str) for a in printed):
                return fail("printed_literal_instead_of_variable", name)
            return fail("missing_print", name)
    return {"ok": True, "issue": None, "name": None}


def simulate_output(code: str) -> list[str] | None:
    """Что напечатает программа. Выполняются только разрешённые присваивания и print."""
    body, problem = parse_program(code)
    if problem or body is None:
        return None
    env: dict[str, Any] = {}
    out: list[str] = []

    def value(node: ast.expr) -> Any:
        if isinstance(node, ast.Name):
            if node.id not in env:
                raise KeyError(node.id)
            return env[node.id]
        assert isinstance(node, ast.Constant)
        return node.value

    try:
        for node in body:
            if isinstance(node, ast.Assign):
                env[node.targets[0].id] = value(node.value)  # type: ignore[union-attr]
            else:
                out.append(str(value(node.value.args[0])))  # type: ignore[attr-defined]
    except KeyError:
        return None
    return out


# ---------------------------------------------------------------- проверка по результату (уроки 2+)

FEATURE_RU = {
    "arith": "арифметику",
    "arith2": "деление, остаток и степень",
    "float": "числа с точкой",
    "augassign": "сокращённые операции вроде +=",
    "fstring": "f-строки",
    "methods": "методы текста и списков",
    "input": "ввод через input",
    "convert": "преобразование типов",
    "compare": "сравнения",
    "bool": "значения True и False",
    "logic": "and, or и not",
    "if": "условия if",
    "for": "цикл for",
    "while": "цикл while",
    "range": "range",
    "loopctl": "break и continue",
    "list": "списки",
    "index": "номер символа или элемента в квадратных скобках",
    "builtins": "встроенные функции вроде len и max",
    "def": "собственные функции",
    "return": "return",
    "call": "вызов своих функций",
}


def _ru(names) -> str:
    return ", ".join(FEATURE_RU.get(n, n) for n in sorted(names))


def check_program(
    code: str,
    task: dict[str, Any],
    allowed: set[str],
    starter: str | None = None,
) -> dict[str, Any]:
    """Проверяет программу по результату её работы на тестах.

    task: tests=[{inputs, output, call?}], must_use=[...], max_lines.
    Возвращает {"ok", "issue", "detail"}; detail — пояснение для ученика.
    """
    from .interp import run_program, used_features  # локальный импорт: интерпретатор тяжёлый

    def fail(issue: str, detail: str = "") -> dict[str, Any]:
        return {"ok": False, "issue": issue, "detail": detail, "name": None}

    lines = _code_lines(code)
    if not lines:
        return fail("empty_code")
    if starter is not None and _same_code(code, starter):
        return fail("unchanged_starter")
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError, RecursionError):
        return fail("syntax_error")

    used = used_features(tree)
    if "__unsupported__" in used:
        return fail("not_learned_yet", "В коде есть конструкция, которой нет в программе курса.")
    extra = used - allowed
    if extra:
        return fail("not_learned_yet", f"Мы ещё не проходили: {_ru(extra)}.")
    max_lines = task.get("max_lines")
    if max_lines and len(lines) > max_lines:
        return fail("too_many_lines")
    missing = [f for f in task.get("must_use", []) if f not in used]
    if missing:
        return fail("missing_construct", f"В задании нужно использовать: {_ru(missing)}.")

    for test in task["tests"]:
        call = test.get("call")
        program = code if not call else code.rstrip("\\n") + "\\n" + call + "\\n"
        res = run_program(program, test.get("inputs", []))
        if res.error is not None:
            if res.error.kind == "too_slow":
                return fail("too_slow", res.error.message)
            return fail("runtime_error", res.error.message)
        got = [ln.rstrip() for ln in res.output]
        while got and got[-1] == "":
            got.pop()
        want = list(test["output"])
        if call:
            got = got[-len(want):] if want else []
        if got != want:
            shown_in = test.get("inputs", [])
            ins = f"На вход: {', '.join(shown_in)}.\\n" if shown_in else ""
            exp = "\\n".join(want) if want else "(ничего)"
            gt = "\\n".join(got) if got else "(ничего)"
            return fail("wrong_output", f"{ins}Ожидалось:\\n{exp}\\nУ тебя получилось:\\n{gt}")
    return {"ok": True, "issue": None, "detail": "", "name": None}
`,n=`"""TeacherController: детерминированный автомат обучения.

step(lesson, state, event) -> (state, messages, meta). Состояние и сообщения —
обычный JSON. Модель (когда появится) может только перефразировать тексты;
решения о прогрессе принимает этот модуль.
"""

from __future__ import annotations

import copy
from typing import Any

from .checker import check_code, check_program
from .intents import classify
from .normalize import normalize

STATE_VERSION = 1
MAX_HELP = 3


# ------------------------------------------------------------------ сообщения


def _msg(state: dict, kind: str, **fields: Any) -> dict:
    state["seq"] += 1
    return {"id": f"m{state['seq']}", "kind": kind, **fields}


def teacher(state, text):
    return _msg(state, "teacher_text", text=text)


def code_example(state, code, caption="Пример"):
    return _msg(state, "code_example", code=code, caption=caption)


def note(state, text):
    return _msg(state, "progress_note", text=text)


def _open(state: dict, m: dict, out: list[dict]) -> None:
    """Добавляет вопрос в ленту и запоминает его как единственный открытый."""
    if state.get("open_id"):
        m["supersedes"] = state["open_id"]
    state["open_id"] = m["id"]
    out.append(m)


def _close(state: dict) -> None:
    state["open_id"] = None


# ------------------------------------------------------------------ доступ к контенту


def _concepts(lesson):
    return lesson["concepts"]


def _concept(lesson, cid):
    return next(c for c in lesson["concepts"] if c["id"] == cid)


def _task(lesson, tid):
    return next(t for t in lesson["practice"] if t["id"] == tid)


def _phrase(lesson, key, **fmt):
    p = lesson["phrases"][key]
    return p.format(**fmt) if fmt else p


def _correct_phrase(lesson, state):
    ph = lesson["phrases"]["correct"]
    return ph[state["seq"] % len(ph)]


# ------------------------------------------------------------------ состояние


def start_state(lesson: dict, seq: int = 0) -> dict:
    return {
        "v": STATE_VERSION,
        "lesson_id": lesson["id"],
        "phase": "new",
        "ci": 0,
        "pi": 0,
        "mi": 0,
        "seq": seq,
        "open_id": None,
        "q": None,  # открытый вопрос
        "task": None,  # открытое задание
        "code": "",  # программа проекта
        "help": 0,  # уровень помощи 0..3
        "mastery": {
            c["id"]: {"state": "not_started", "needs_review": False, "errors": 0, "helped": False, "evidence": []}
            for c in lesson["concepts"]
        },
        "escalations": [],
        "reviewed": [],
    }


def _set_help(state, level):
    state["help"] = max(state["help"], min(level, MAX_HELP))


def _evidence(state, cid, kind):
    ev = state["mastery"][cid]["evidence"]
    if kind not in ev:
        ev.append(kind)


def _required(concept, m):
    req = set(concept["evidence_policy"]["require"])
    if m["errors"] or m["helped"]:
        req |= set(concept["evidence_policy"]["after_error"])
    return req


def _refresh_mastery(lesson, state, cid, out):
    """Обновляет состояние освоения темы; сообщает, когда тема освоена."""
    concept = _concept(lesson, cid)
    m = state["mastery"][cid]
    if m["state"] == "mastered":
        return
    have = set(m["evidence"])
    if _required(concept, m) <= have and not m["needs_review"]:
        m["state"] = "mastered"
        out.append(note(state, f"{_phrase(lesson, 'concept_mastered')} {concept['title']}"))
    elif "structured_check" in have:
        m["state"] = "practiced"


def _mastered_count(state):
    return sum(1 for m in state["mastery"].values() if m["state"] == "mastered")


# ------------------------------------------------------------------ вопросы


def _ask(state, lesson, q: dict, out, *, intro: list[dict] | None = None):
    """Показывает вопрос из контента. q — запись состояния {kind, concept, ...}."""
    concept = _concept(lesson, q["concept"])
    question = _question_of(concept, q)
    out.extend(intro or [])
    if question["format"] == "choice":
        opts = [{"id": f"o{i}", "label": o} for i, o in enumerate(question["options"])]
        m = _msg(state, "choice_question", prompt=question["meaning"], options=opts)
    else:
        m = _msg(state, "text_question", prompt=question["meaning"])
    _open(state, m, out)
    state["q"] = q
    state["task"] = None


def _question_of(concept, q):
    return concept["transfer_question"]["question"] if q["stage"] == "transfer" else concept["question"]


def _judge(question: dict, text: str) -> tuple[str, dict | None]:
    mode = question.get("match_mode", "text")
    t = normalize(text, mode)
    if t in {normalize(a, mode) for a in question["accept"]}:
        return "correct", None
    if question.get("help_option") and t == normalize(question["help_option"], mode):
        return "dont_know", None
    for mis in question.get("misconceptions", []):
        if t in {normalize(x, mode) for x in mis["match"]}:
            return "misconception", mis
    if classify(text) == "dont_know":
        return "dont_know", None
    return "wrong", None


def _present_concept(state, lesson, i, out):
    concept = _concepts(lesson)[i]
    state["phase"] = "concept"
    state["ci"] = i
    state["help"] = 0
    out.append(note(state, f"Тема {i + 1} из {len(_concepts(lesson))} · {concept['title']}"))
    out.append(teacher(state, concept["explain"]))
    q = {"kind": "concept", "stage": "main", "concept": concept["id"], "attempts": 0, "dk": 0}
    _ask(state, lesson, q, out, intro=[code_example(state, concept["example"])])
    state["mastery"][concept["id"]]["state"] = "introduced"


def _after_main_question(state, lesson, out):
    """После верного ответа на основной вопрос: перенос на новый пример или конец темы."""
    cid = state["q"]["concept"]
    concept = _concept(lesson, cid)
    m = state["mastery"][cid]
    if "transfer" in _required(concept, m):
        tq = {"kind": "concept", "stage": "transfer", "concept": cid, "attempts": 0, "dk": 0}
        intro = [teacher(state, _phrase(lesson, "transfer_intro")), code_example(state, concept["transfer_question"]["example"], "Новый пример")]
        _ask(state, lesson, tq, out, intro=intro)
    else:
        _finish_concept(state, lesson, out)


def _finish_concept(state, lesson, out):
    cid = state["q"]["concept"] if state.get("q") else _concepts(lesson)[state["ci"]]["id"]
    state["q"] = None
    _close(state)
    _refresh_mastery(lesson, state, cid, out)
    nxt = state["ci"] + 1
    if nxt < len(_concepts(lesson)):
        _present_concept(state, lesson, nxt, out)
    else:
        out.append(teacher(state, _phrase(lesson, "concepts_done")))
        _present_task(state, lesson, 0, out)


def _log_escalation(state, reason, cid):
    entry = {"reason": reason, "concept": cid}
    if entry not in state["escalations"]:
        state["escalations"].append(entry)


def _answer_question(state, lesson, text, out):
    q = state["q"]
    concept = _concept(lesson, q["concept"])
    question = _question_of(concept, q)
    m = state["mastery"][concept["id"]]
    verdict, mis = _judge(question, text)
    transfer = q["stage"] == "transfer"
    review = q["kind"] == "review"

    if verdict == "correct":
        prior_trouble = q["attempts"] > 0 or q["dk"] > 0
        phrase = _phrase(lesson, "correct_after_help") if prior_trouble else _correct_phrase(lesson, state)
        out.append(teacher(state, phrase))
        state["help"] = 0 if not prior_trouble else state["help"]
        if review:
            m["needs_review"] = False
            _evidence(state, concept["id"], "transfer")
            _finish_review(state, lesson, out)
            return
        if transfer:
            _evidence(state, concept["id"], "transfer")
            _finish_concept(state, lesson, out)
        else:
            _evidence(state, concept["id"], "structured_check")
            if question["format"] == "input":
                _evidence(state, concept["id"], "non_choice")
            if prior_trouble:
                m["helped"] = True
            _after_main_question(state, lesson, out)
        return

    # --- не верно или «не знаю»
    if verdict == "dont_know":
        q["dk"] += 1
        m["helped"] = True
    else:
        q["attempts"] += 1
        m["errors"] += 1
        if m["errors"] >= 2:
            _log_escalation(state, "repeated_confusion", concept["id"])
    trouble = q["attempts"] + q["dk"]

    if transfer or review:
        _wrong_on_transfer(state, lesson, q, concept, question, verdict, mis, trouble, out)
        return

    if trouble >= 3 or (verdict == "dont_know" and q["dk"] >= 2):
        _walkthrough_then_transfer(state, lesson, q, concept, out)
        return
    if verdict == "dont_know":
        _set_help(state, 2)
        out.append(teacher(state, _phrase(lesson, "dont_know")))
        out.append(teacher(state, concept["reteach"]))
    elif mis and trouble == 1:
        _set_help(state, 1)
        out.append(teacher(state, f"{mis['hint']} {mis['followup']}"))
    else:
        _set_help(state, 2)
        out.append(teacher(state, f"{_phrase(lesson, 'reteach_intro')} {concept['reteach']}"))
    out.append(teacher(state, _phrase(lesson, "try_again")))
    _ask(state, lesson, q, out)


def _walkthrough_then_transfer(state, lesson, q, concept, out):
    _set_help(state, 3)
    out.append(teacher(state, concept["walkthrough"]))
    tq = {"kind": "concept", "stage": "transfer", "concept": concept["id"], "attempts": 0, "dk": 0}
    intro = [teacher(state, _phrase(lesson, "transfer_intro")), code_example(state, concept["transfer_question"]["example"], "Новый пример")]
    _ask(state, lesson, tq, out, intro=intro)


def _wrong_on_transfer(state, lesson, q, concept, question, verdict, mis, trouble, out):
    cid = concept["id"]
    m = state["mastery"][cid]
    if trouble >= 2:
        # Перенос не получился: разбираем и идём дальше, тема остаётся на повторение.
        _set_help(state, 3)
        _log_escalation(state, "transfer_failed", cid)
        m["needs_review"] = True
        out.append(teacher(state, concept["walkthrough"]))
        if q["kind"] == "review":
            _finish_review(state, lesson, out)
        else:
            _finish_concept(state, lesson, out)
        return
    if verdict == "dont_know":
        out.append(teacher(state, f"{_phrase(lesson, 'dont_know')} {_phrase(lesson, 'assessment_help')} {concept['reteach']}"))
    elif mis:
        out.append(teacher(state, f"{mis['hint']} {mis['followup']}"))
    else:
        out.append(teacher(state, f"{_phrase(lesson, 'reteach_intro')} {concept['reteach']}"))
    out.append(teacher(state, _phrase(lesson, "try_again")))
    _ask(state, lesson, q, out)


# ------------------------------------------------------------------ практика


def _present_task(state, lesson, i, out):
    practice = lesson["practice"]
    if i >= len(practice):
        _start_project(state, lesson, out)
        return
    task = practice[i]
    state["phase"] = "practice"
    state["pi"] = i
    state["help"] = 0
    out.append(note(state, f"Практика {i + 1} из {len(practice)}"))
    if i == 0:
        out.append(teacher(state, _phrase(lesson, "practice_intro")))
    t = {"kind": "practice", "id": task["id"], "attempts": 0, "hinted": False}
    _open_task(state, task["prompt"], task.get("starter_code") or "", t, out)


def _open_task(state, prompt, starter, t, out):
    m = _msg(state, "code_task", prompt=prompt, starter=starter)
    _open(state, m, out)
    state["task"] = t
    state["q"] = None


def _allowed(lesson):
    return set(lesson.get("allowed_features") or lesson.get("features") or [])


def _submit_code(state, lesson, code, out):
    t = state["task"]
    if t["kind"] == "practice":
        task = _task(lesson, t["id"])
        max_lines, starter, hint = task["max_lines"], task.get("starter_code"), task["hint"]
        spec = task
    elif t["kind"] == "assignment":
        spec = lesson["assignment"]
        max_lines, starter, hint = spec["max_lines"], None, spec["hint"]
    elif t["kind"] == "warmup":
        spec = lesson["assignment"]["warmup"]
        max_lines, starter, hint = spec["max_lines"], None, spec["hint"]
    else:
        step = lesson["project"]["steps"][state["mi"]]
        max_lines, starter, hint = lesson["project"]["max_lines"], state["code"] + ("\\n" if state["code"] else ""), step["hint"]
        spec = step

    if spec.get("tests"):
        check_spec = {"tests": spec["tests"], "must_use": spec.get("must_use", []), "max_lines": max_lines}
        result = check_program(code, check_spec, _allowed(lesson), starter)
    else:
        if t["kind"] == "practice":
            rules = spec["expected"]
        else:
            rules = [r for s_ in lesson["project"]["steps"][: state["mi"] + 1] for r in s_.get("adds", [])]
        result = check_code(code, rules, max_lines, starter)
    t["attempts"] += 1
    if not result["ok"]:
        issue = result["issue"]
        text = lesson["code_feedback"][issue]
        if issue in ("wrong_variable_name", "missing_assignment", "missing_print") and result.get("name"):
            text += f" Нужное имя: {result['name']}."
        if result.get("detail"):
            text += "\\n" + result["detail"]
        out.append(teacher(state, text))
        out.append(teacher(state, _phrase(lesson, "practice_retry")))
        if t["attempts"] >= 3 and not t["hinted"]:
            t["hinted"] = True
            _set_help(state, 2)
            out.append(teacher(state, f"Подсказка. {hint}"))
        _open_task(state, "Исправь код и нажми «Проверить».", code, t, out)
        return

    # принято
    out.append(teacher(state, _phrase(lesson, "practice_correct")))
    _close(state)
    state["task"] = None
    if t["kind"] == "practice":
        task = _task(lesson, t["id"])
        for cid in task["concepts"]:
            m = state["mastery"][cid]
            if _concept(lesson, cid)["evidence_policy"].get("independent_task") == task["id"]:
                if t["hinted"]:
                    m["needs_review"] = True
                else:
                    _evidence(state, cid, "independent")
                    m["needs_review"] = False
            _refresh_mastery(lesson, state, cid, out)
        _present_task(state, lesson, state["pi"] + 1, out)
    elif t["kind"] == "warmup":
        out.append(teacher(state, _phrase(lesson, "warmup_done")))
        _start_main_assignment(state, lesson, out)
    elif t["kind"] == "assignment":
        state["assignment_code"] = code.strip("\\n")
        _finish_lesson(state, lesson, out)
    else:
        state["code"] = code.strip("\\n")
        _next_step(state, lesson, state["mi"] + 1, out)


def _task_hint(state, lesson, out):
    t = state["task"]
    _set_help(state, 1)
    t["hinted"] = True
    if t["kind"] == "practice":
        task = _task(lesson, t["id"])
        out.append(teacher(state, f"Подсказка. {task['hint']}"))
        if task["mode"] == "guided" and task.get("example"):
            out.append(code_example(state, task["example"], "Похожий пример"))
    elif t["kind"] == "warmup":
        out.append(teacher(state, f"Подсказка. {lesson['assignment']['warmup']['hint']}"))
    elif t["kind"] == "assignment":
        out.append(teacher(state, f"Подсказка. {lesson['assignment']['hint']}"))
    else:
        out.append(teacher(state, f"Подсказка. {lesson['project']['steps'][state['mi']]['hint']}"))


# ------------------------------------------------------------------ проект


def _start_project(state, lesson, out):
    p = lesson["project"]
    state["phase"] = "project"
    state["mi"] = 0
    state["code"] = ""
    out.append(note(state, f"Проект · {p['title']}"))
    out.append(teacher(state, p["intro"]))
    _next_step(state, lesson, 0, out)


def _next_step(state, lesson, i, out):
    p = lesson["project"]
    if i >= len(p["steps"]):
        _start_assignment(state, lesson, out)
        return
    state["mi"] = i
    state["help"] = 0
    step = p["steps"][i]
    # Если нужная тема требует повторения, сначала возвращаемся к ней.
    weak = [c for c in step["requires"] if state["mastery"][c]["needs_review"] and c not in state["reviewed"]]
    if weak:
        concept = _concept(lesson, weak[0])
        out.append(teacher(state, _phrase(lesson, "project_paused")))
        out.append(teacher(state, _phrase(lesson, "review_intro", title=concept["title"])))
        out.append(teacher(state, concept["reteach"]))
        q = {"kind": "review", "stage": "transfer", "concept": weak[0], "attempts": 0, "dk": 0}
        intro = [code_example(state, concept["transfer_question"]["example"], "Новый пример")]
        _ask(state, lesson, q, out, intro=intro)
        return
    out.append(note(state, f"Шаг {i + 1} из {len(p['steps'])}"))
    if step["kind"] == "code":
        starter = state["code"] + ("\\n" if state["code"] else "")
        t = {"kind": "project", "id": step["id"], "attempts": 0, "hinted": False}
        out.append(teacher(state, step["prompt"]))
        _open_task(state, "Напиши код и нажми «Проверить».", starter, t, out)
    else:
        expected = _program_output(state["code"], step.get("inputs", []))
        state["expected_output"] = expected
        state["pred_attempts"] = 0
        out.append(code_example(state, state["code"], "Твоя программа"))
        m = _msg(state, "text_question", prompt=step["prompt"])
        _open(state, m, out)
        state["q"] = {"kind": "predict", "stage": "main", "concept": step["requires"][0], "attempts": 0, "dk": 0}
        state["task"] = None


def _program_output(code, inputs):
    from .interp import run_program

    res = run_program(code, list(inputs))
    lines = [ln.rstrip() for ln in res.output]
    return [ln for ln in lines if ln.strip()]


def _start_assignment(state, lesson, out):
    """Тестовое задание начинается с разминки: маленькой задачи на ту же тему."""
    a = lesson["assignment"]
    state["phase"] = "assignment"
    state["help"] = 0
    out.append(note(state, f"Разминка · {a['title']}"))
    out.append(teacher(state, f"{_phrase(lesson, 'warmup_intro')}\\n\\n{a['warmup']['prompt']}"))
    t = {"kind": "warmup", "id": a["id"] + "w", "attempts": 0, "hinted": False}
    _open_task(state, "Напиши решение и нажми «Проверить».", "", t, out)


def _start_main_assignment(state, lesson, out):
    a = lesson["assignment"]
    state["help"] = 0
    out.append(note(state, f"Тестовое задание · {a['level']} · {a['title']}"))
    out.append(teacher(state, lesson["phrases"]["assignment_intro"]))
    reqs = "\\n".join(f"• {r}" for r in a["requirements"])
    plan = "\\n".join(f"{i}. {step}" for i, step in enumerate(a["plan"], 1))
    out.append(teacher(state, f"{a['brief']}\\n\\nТребования:\\n{reqs}\\n\\nС чего начать:\\n{plan}"))
    t = {"kind": "assignment", "id": a["id"], "attempts": 0, "hinted": False}
    _open_task(state, "Напиши решение и нажми «Проверить». Программу проверят на нескольких наборах данных, не только на примерах из задания.", "", t, out)


def _finish_review(state, lesson, out):
    cid = state["q"]["concept"]
    state["q"] = None
    _close(state)
    out.append(teacher(state, _phrase(lesson, "project_resumed")))
    state["reviewed"].append(cid)
    _refresh_mastery(lesson, state, cid, out)
    _next_step(state, lesson, state["mi"], out)


def _answer_prediction(state, lesson, text, out):
    expected = state["expected_output"]
    got = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    q = state["q"]
    if [normalize(x) for x in got] == [normalize(x) for x in expected]:
        out.append(teacher(state, _phrase(lesson, "practice_correct")))
        state["q"] = None
        _close(state)
        _next_step(state, lesson, state["mi"] + 1, out)
        return
    q["attempts"] += 1
    if q["attempts"] >= 3:
        out.append(teacher(state, f"{_phrase(lesson, 'predict_reveal')}\\n" + "\\n".join(expected)))
        state["q"] = None
        _close(state)
        _next_step(state, lesson, state["mi"] + 1, out)
        return
    printed_names = {ln.strip()[6:-1] for ln in state["code"].splitlines() if ln.strip().startswith("print(")}
    named = None
    if any(x[:1] in "\\"'«" for x in got):
        named = _find_misconception(lesson, "quotes_printed")
    elif any(x in printed_names for x in got):
        named = _find_misconception(lesson, "prints_name")
    hint = lesson["project"]["steps"][state["mi"]]["hint"]
    out.append(teacher(state, named["hint"] if named else hint))
    out.append(teacher(state, _phrase(lesson, "try_again")))
    m = _msg(state, "text_question", prompt=lesson["project"]["steps"][state["mi"]]["prompt"])
    _open(state, m, out)


def _find_misconception(lesson, mid):
    for c in lesson["concepts"]:
        for mis in c["question"].get("misconceptions", []):
            if mis["id"] == mid:
                return mis
    return None


def _finish_lesson(state, lesson, out):
    state["phase"] = "done"
    state["q"] = None
    state["task"] = None
    _close(state)
    p = lesson["project"]
    out.append(teacher(state, p["outro"]))
    out.append(note(state, f"Освоено тем: {_mastered_count(state)} из {len(state['mastery'])}"))
    out.append(teacher(state, _phrase(lesson, "lesson_complete")))
    weak = [c["title"] for c in lesson["concepts"] if state["mastery"][c["id"]]["state"] != "mastered"]
    if weak:
        out.append(teacher(state, "Эти темы стоит повторить: " + ", ".join(weak) + "."))


# ------------------------------------------------------------------ свободный текст и быстрые действия


def _reply_to_free_text(state, lesson, text, out):
    faq = [f for c in _concepts(lesson) for f in c.get("faq", [])]
    intent = classify(text, faq, _allowed(lesson))
    phase = state["phase"]
    q, task = state.get("q"), state.get("task")

    if phase == "done":
        if intent.startswith("faq:"):
            out.append(teacher(state, faq[int(intent.split(":")[1])]["answer"]))
        else:
            out.append(teacher(state, _phrase(lesson, "next_lessons")))
        return

    if intent.startswith("faq:"):
        out.append(teacher(state, faq[int(intent.split(":")[1])]["answer"]))
    elif intent == "future":
        out.append(teacher(state, _phrase(lesson, "not_learned_yet")))
    elif intent == "why":
        out.append(teacher(state, _phrase(lesson, "why_fallback")))
    elif intent in ("help_me", "dont_know"):
        _explain_again(state, lesson, out)
    elif intent == "hint":
        if task:
            _task_hint(state, lesson, out)
            return
        _explain_again(state, lesson, out)
    elif intent == "example":
        _show_example(state, lesson, out)
    elif intent == "repeat":
        pass
    else:
        out.append(teacher(state, _phrase(lesson, "clarify") if q else _phrase(lesson, "off_topic")))

    # Вернуться к открытому вопросу: задание остаётся на экране, вопрос показываем снова.
    if q and state.get("open_id"):
        out.append(teacher(state, _phrase(lesson, "return_to_question")))
        _reask(state, lesson, out)
    elif task and intent == "repeat":
        out.append(teacher(state, f"{_phrase(lesson, 'return_to_question')} {_task_prompt(state, lesson)}"))


def _task_prompt(state, lesson):
    t = state["task"]
    if t["kind"] == "practice":
        return _task(lesson, t["id"])["prompt"]
    if t["kind"] == "warmup":
        return lesson["assignment"]["warmup"]["prompt"]
    if t["kind"] == "assignment":
        return lesson["assignment"]["title"]
    return lesson["project"]["steps"][state["mi"]]["prompt"]


def _reask(state, lesson, out):
    q = state["q"]
    if q["kind"] == "predict":
        m = _msg(state, "text_question", prompt=lesson["project"]["steps"][state["mi"]]["prompt"])
        _open(state, m, out)
        return
    _ask(state, lesson, q, out)


def _explain_again(state, lesson, out):
    _set_help(state, 2)
    q, task = state.get("q"), state.get("task")
    if q and q["kind"] != "predict":
        concept = _concept(lesson, q["concept"])
        assessment = q["stage"] == "transfer"
        state["mastery"][concept["id"]]["helped"] = True
        if assessment:
            out.append(teacher(state, f"{_phrase(lesson, 'assessment_help')} {concept['reteach']}"))
        else:
            out.append(teacher(state, f"{_phrase(lesson, 'reteach_intro')} {concept['reteach']}"))
    elif task:
        _task_hint(state, lesson, out)
    elif q:
        out.append(teacher(state, lesson["project"]["steps"][state["mi"]]["hint"]))
    else:
        out.append(teacher(state, _phrase(lesson, "hint_no_open")))


def _show_example(state, lesson, out):
    q = state.get("q")
    concept = None
    if q and q["kind"] != "predict":
        concept = _concept(lesson, q["concept"])
    elif state["phase"] == "practice" and state.get("task"):
        concept = _concept(lesson, _task(lesson, state["task"]["id"])["concepts"][0])
    elif state["phase"] == "project":
        concept = _concept(lesson, lesson["project"]["steps"][state["mi"]]["requires"][0])
    if concept and concept.get("alt_examples"):
        alt = concept["alt_examples"][0]
        out.append(code_example(state, alt["code"], "Ещё пример"))
        out.append(teacher(state, alt["explain"]))
    else:
        out.append(teacher(state, _phrase(lesson, "hint_no_open")))


# ------------------------------------------------------------------ вход


def step(lesson: dict, state: dict, event: dict) -> dict:
    """Один ход. Возвращает {"state", "messages", "action"}; входное состояние не меняется."""
    state = copy.deepcopy(state)
    out: list[dict] = []
    etype = event.get("type")

    if etype == "start":
        if state["phase"] == "new":
            if lesson.get("welcome"):
                out.append(teacher(state, lesson["welcome"]))
            else:
                out.append(teacher(state, _phrase(lesson, "greeting")))
                out.append(teacher(state, _phrase(lesson, "how_to_use")))
            _present_concept(state, lesson, 0, out)
        return _result(lesson, state, out, "EXPLAIN_AND_CHECK")

    if state["phase"] == "new":
        return _result(lesson, state, out, "CLARIFY")

    action = "CLARIFY"
    if etype == "choose":
        q = state.get("q")
        if q and q["kind"] != "predict":
            question = _question_of(_concept(lesson, q["concept"]), q)
            idx = int(str(event.get("option_id", "o-1"))[1:] or -1)
            if 0 <= idx < len(question.get("options", [])):
                _answer_question(state, lesson, question["options"][idx], out)
                action = "FEEDBACK_AND_CONTINUE"
    elif etype == "code":
        if state.get("task"):
            _submit_code(state, lesson, str(event.get("code", "")), out)
            action = "PROJECT_GUIDANCE" if state["phase"] in ("project", "assignment") else "GUIDED_STEP"
    elif etype in ("text", "quick"):
        text = str(event.get("text", "")).strip()
        q = state.get("q")
        if text and state.get("task") and _looks_like_code(text):
            # Код, написанный прямо в чате, проверяется как ответ на открытое задание.
            _submit_code(state, lesson, text, out)
            action = "PROJECT_GUIDANCE" if state["phase"] in ("project", "assignment") else "GUIDED_STEP"
        elif text:
            if q and _is_answer(lesson, state, text):
                if q["kind"] == "predict":
                    _answer_prediction(state, lesson, text, out)
                else:
                    _answer_question(state, lesson, text, out)
                action = "FEEDBACK_AND_CONTINUE"
            else:
                _reply_to_free_text(state, lesson, text, out)
                action = "ASSESSMENT_HELP" if q and q["stage"] == "transfer" else "CLARIFY"
    return _result(lesson, state, out, action)


def _looks_like_code(text: str) -> bool:
    """Строка похожа на код задания: есть присваивание или вызов print."""
    head = text.lstrip().split("(")[0].split(" ")[0]
    return "=" in text or head in ("print", "for", "while", "if", "def", "input") or "\\n    " in text


def _is_answer(lesson, state, text):
    """Считаем текст ответом, если он не команда и не вопрос. Для input-вопросов — почти всегда."""
    q = state["q"]
    if q["kind"] == "predict":
        return classify(text, None, _allowed(lesson)) not in ("help_me", "hint", "example", "repeat", "future", "why", "dont_know")
    question = _question_of(_concept(lesson, q["concept"]), q)
    verdict, _ = _judge(question, text)
    if verdict in ("correct", "dont_know", "misconception"):
        return True
    intent = classify(text, [f for c in _concepts(lesson) for f in c.get("faq", [])], _allowed(lesson))
    if intent != "unknown":
        return False
    return question["format"] == "input"


def progress(lesson: dict, state: dict) -> dict:
    """Положение ученика в уроке для заголовка и главного экрана."""
    n, m, k = len(lesson["concepts"]), len(lesson["practice"]), len(lesson["project"]["steps"])
    total = n + m + k + 2
    phase = state["phase"]
    if phase == "concept":
        i = state["ci"]
        return {"done": i, "total": total, "label": f"Тема {i + 1} из {n} · {lesson['concepts'][i]['title']}"}
    if phase == "practice":
        i = state["pi"]
        return {"done": n + i, "total": total, "label": f"Практика {i + 1} из {m}"}
    if phase == "project":
        i = state["mi"]
        return {"done": n + m + i, "total": total, "label": f"Проект · шаг {i + 1} из {k}"}
    if phase == "assignment":
        task = state.get("task")
        if task and task["kind"] == "assignment":
            return {"done": n + m + k + 1, "total": total, "label": "Тестовое задание"}
        return {"done": n + m + k, "total": total, "label": "Разминка перед заданием"}
    if phase == "done":
        return {"done": total, "total": total, "label": "Урок пройден"}
    return {"done": 0, "total": total, "label": ""}


def _result(lesson, state, out, action):
    return {"state": state, "messages": out, "action": action, "progress": progress(lesson, state)}
`,r=`"""Курс целиком: несколько уроков подряд.

Обёртка над controller: ведёт ученика от урока к уроку, накапливает
разрешённые возможности языка и хранит готовые проекты. Все решения
детерминированы, состояние — обычный JSON.
"""

from __future__ import annotations

import copy
from typing import Any

from . import controller

COURSE_STATE_VERSION = 2

_GO_PREFIX = ("дальше", "далее", "давай", "продолж", "поехали", "следующ", "готов")
_GO_EXACT = ("да", "ок", "окей", "го", "next")


def _lesson_view(course: dict, li: int) -> dict:
    """Урок с накопленным списком возможностей языка (всё, что открыто к этому уроку)."""
    lesson = dict(course["lessons"][li])
    allowed: list[str] = []
    for prev in course["lessons"][: li + 1]:
        allowed += [f for f in prev.get("features", []) if f not in allowed]
    lesson["allowed_features"] = allowed
    return lesson


def start_course_state(course: dict) -> dict:
    first = course["lessons"][0]
    return {
        "v": COURSE_STATE_VERSION,
        "li": 0,
        "lesson": controller.start_state(first),
        "completed": [],
        "projects": [],
        "portfolio": [],
        "gate": False,
        "open_id": None,
        "seq": 0,
    }


def _sync_out(state: dict) -> None:
    inner = state["lesson"]
    state["seq"] = inner["seq"]
    state["open_id"] = inner["open_id"]


def _record_project(course: dict, state: dict) -> None:
    lesson = course["lessons"][state["li"]]
    inner = state["lesson"]
    if lesson["id"] in state["completed"]:
        return
    state["completed"].append(lesson["id"])
    state["projects"].append(
        {
            "lesson_id": lesson["id"],
            "lesson_title": lesson["title"],
            "title": lesson["project"]["title"],
            "code": inner.get("code", ""),
        }
    )
    a = lesson["assignment"]
    state["portfolio"].append(
        {
            "lesson_id": lesson["id"],
            "lesson_title": lesson["title"],
            "title": a["title"],
            "level": a["level"],
            "summary": a["summary"],
            "brief": a["brief"],
            "requirements": a["requirements"],
            "code": inner.get("assignment_code", ""),
        }
    )


def _gate_message(course: dict, state: dict, out: list[dict]) -> None:
    inner = state["lesson"]
    nxt = course["lessons"][state["li"] + 1]
    inner["seq"] += 1
    mid = f"m{inner['seq']}"
    out.append(
        {
            "id": mid,
            "kind": "choice_question",
            "prompt": f"Дальше — урок {state['li'] + 2}: «{nxt['title']}». Продолжим?",
            "options": [{"id": "next", "label": "К следующему уроку"}],
        }
    )
    inner["open_id"] = mid
    state["gate"] = True


def _start_next_lesson(course: dict, state: dict, out: list[dict]) -> None:
    seq = state["lesson"]["seq"]
    state["li"] += 1
    state["gate"] = False
    lesson = _lesson_view(course, state["li"])
    state["lesson"] = controller.start_state(lesson, seq)
    res = controller.step(lesson, state["lesson"], {"type": "start"})
    state["lesson"] = res["state"]
    out.extend(res["messages"])


def _after_lesson_turn(course: dict, state: dict, out: list[dict]) -> None:
    inner = state["lesson"]
    if inner["phase"] != "done":
        return
    _record_project(course, state)
    if state["li"] + 1 < len(course["lessons"]):
        _gate_message(course, state, out)
    else:
        inner["seq"] += 1
        out.append(
            {
                "id": f"m{inner['seq']}",
                "kind": "teacher_text",
                "text": course.get("finale", "Курс пройден. Все твои проекты лежат в разделе «Мои проекты»."),
            }
        )


def course_step(course: dict, state: dict, event: dict) -> dict:
    state = copy.deepcopy(state)
    out: list[dict] = []
    action = "CLARIFY"
    etype = event.get("type")
    lesson = _lesson_view(course, state["li"])

    if state["gate"]:
        choice = None
        if etype == "choose":
            choice = event.get("option_id")
        elif etype in ("text", "quick"):
            t = str(event.get("text", "")).strip().lower()
            if t and (t in _GO_EXACT or t.startswith(_GO_PREFIX)):
                choice = "next"
        if choice == "next":
            state["lesson"]["open_id"] = None
            _start_next_lesson(course, state, out)
            action = "EXPLAIN_AND_CHECK"
        else:
            out.append(controller.teacher(state["lesson"], "Когда будешь готов, нажми «К следующему уроку»."))
        _sync_out(state)
        return _result(course, state, out, action)

    res = controller.step(lesson, state["lesson"], event)
    state["lesson"] = res["state"]
    out.extend(res["messages"])
    action = res["action"]
    _after_lesson_turn(course, state, out)
    _sync_out(state)
    return _result(course, state, out, action)


def course_progress(course: dict, state: dict) -> dict:
    lesson = _lesson_view(course, state["li"])
    cur = controller.progress(lesson, state["lesson"])
    lessons: list[dict[str, Any]] = []
    for i, ls in enumerate(course["lessons"]):
        if ls["id"] in state["completed"]:
            status = "done"
        elif i == state["li"]:
            status = "current"
        else:
            status = "locked"
        lessons.append({"id": ls["id"], "title": ls["title"], "status": status})
    return {
        "done": cur["done"],
        "total": cur["total"],
        "label": cur["label"],
        "lesson_no": state["li"] + 1,
        "lesson_count": len(course["lessons"]),
        "lesson_title": course["lessons"][state["li"]]["title"],
        "lessons": lessons,
        "projects": state["projects"],
        "portfolio": state["portfolio"],
        "finished": len(state["completed"]) == len(course["lessons"]),
    }


def _result(course: dict, state: dict, out: list[dict], action: str) -> dict:
    return {"state": state, "messages": out, "action": action, "progress": course_progress(course, state)}
`,i=`"""Классификация свободного текста правилами (без модели).

Вызывается, только когда текст не подошёл как ответ на открытый вопрос.
"""

from __future__ import annotations

import re

from .normalize import normalize

_HELP = re.compile(r"не понял|не понима|непонятн|не ясно|не пойму|запутал|объясни|проще|по-другому|по другому")
_HINT = re.compile(r"подсказк|помоги|помощь")
_EXAMPLE = re.compile(r"пример")
_REPEAT = re.compile(r"повтор|еще раз|что спрашива|какой вопрос")
_DONT_KNOW = re.compile(r"^(не знаю|без понятия|не помню|понятия не имею)")
_WHY = re.compile(r"почему|зачем|для чего|что такое|что значит|что это")
# Темы, которые ещё могут быть не пройдены: (шаблон, нужная возможность языка | None — вне курса).
_TOPICS: list[tuple[re.Pattern[str], str | None]] = [
    (re.compile(r"цикл|\\bfor\\b|\\bwhile\\b|повторени"), "for"),
    (re.compile(r"функци|\\bdef\\b|\\breturn\\b"), "def"),
    (re.compile(r"список|\\blist\\b|\\bappend\\b"), "list"),
    (re.compile(r"услови|\\bif\\b|\\belse\\b"), "if"),
    (re.compile(r"input|ввод"), "input"),
    (re.compile(r"сложи|склад|плюс|\\+|математик|арифметик|умнож|дели"), "arith"),
    (re.compile(r"класс|импорт|import|словар|модул|файл"), None),
]

QUICK = {
    "Объясни проще": "help_me",
    "Подсказка": "hint",
    "Пример": "example",
    "Повтори": "repeat",
}


def classify(text: str, faq: list[dict] | None = None, allowed: set[str] | frozenset[str] | None = None) -> str:
    """Возвращает: dont_know, quick-интент, faq:<i>, future, why или unknown."""
    if text in QUICK:
        return QUICK[text]
    t = normalize(text, "text")
    if _DONT_KNOW.search(t):
        return "dont_know"
    if _HELP.search(t):
        return "help_me"
    if _HINT.search(t):
        return "hint"
    if _REPEAT.search(t):
        return "repeat"
    for i, item in enumerate(faq or []):
        if any(normalize(k, "text") in t for k in item["keywords"]):
            return f"faq:{i}"
    known = allowed or set()
    for pattern, feature in _TOPICS:
        if pattern.search(t) and (feature is None or feature not in known):
            return "future"
    if _EXAMPLE.search(t):
        return "example"
    if _WHY.search(t):
        return "why"
    return "unknown"
`,a=`"""Безопасный интерпретатор учебного подмножества Python.

Код ученика НЕ выполняется средой Python. Он разбирается через ast и
исполняется этим интерпретатором, который знает только разрешённые узлы,
встроенные функции и методы. Нет импортов, файлов, сети, атрибутов объектов,
классов, исключений. Есть бюджет шагов и ограничение размеров.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Any

MAX_STEPS = 40_000
MAX_DEPTH = 40
MAX_SEQ = 20_000


class LearnerError(Exception):
    """Ошибка в программе ученика. kind: name, type, zero, index, value, too_slow, input, unsupported."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


class _Break(Exception):
    pass


class _Continue(Exception):
    pass


class _Return(Exception):
    def __init__(self, value: Any):
        self.value = value


@dataclass
class Func:
    name: str
    params: list[str]
    body: list[ast.stmt]
    env: "Env"


class Env:
    def __init__(self, parent: "Env | None" = None):
        self.vars: dict[str, Any] = {}
        self.parent = parent

    def lookup(self, name: str) -> Any:
        e: Env | None = self
        while e is not None:
            if name in e.vars:
                return e.vars[name]
            e = e.parent
        raise LearnerError("name", f"Python не знает имя «{name}». Если это текст, возьми его в кавычки. Если это переменная, сначала сохрани в неё значение.")


@dataclass
class RunResult:
    output: list[str] = field(default_factory=list)  # то, что вывел print, по строкам
    error: LearnerError | None = None
    globals: dict[str, Any] = field(default_factory=dict)


_STR_METHODS = {
    "upper", "lower", "title", "strip", "replace", "count", "startswith", "endswith",
    "split", "join", "isdigit", "find", "capitalize",
}
_LIST_METHODS = {"append", "pop", "insert", "remove", "sort", "reverse", "count", "index"}
_BUILTINS = {"print", "input", "int", "float", "str", "len", "range", "abs", "round", "max", "min", "sum", "sorted", "list", "bool"}

_BINOPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
    ast.Pow: lambda a, b: a**b,
}
_CMPOPS = {
    ast.Eq: lambda a, b: a == b,
    ast.NotEq: lambda a, b: a != b,
    ast.Lt: lambda a, b: a < b,
    ast.Gt: lambda a, b: a > b,
    ast.LtE: lambda a, b: a <= b,
    ast.GtE: lambda a, b: a >= b,
    ast.In: lambda a, b: a in b,
    ast.NotIn: lambda a, b: a not in b,
}

_TYPE_NAMES = {int: "число", float: "число с точкой", str: "текст", list: "список", bool: "логическое значение", type(None): "ничего"}


def _tn(v: Any) -> str:
    return _TYPE_NAMES.get(type(v), "значение")


class _Machine:
    def __init__(self, inputs: list[str], max_steps: int):
        self.inputs = list(inputs)
        self.out: list[str] = []
        self.steps = 0
        self.max_steps = max_steps
        self.depth = 0
        self.globals = Env()

    # --- служебное
    def tick(self) -> None:
        self.steps += 1
        if self.steps > self.max_steps:
            raise LearnerError("too_slow", "Программа работает слишком долго. Возможно, цикл никогда не заканчивается.")

    def emit(self, text: str) -> None:
        self.out.append(text)

    # --- выражения
    def ev(self, node: ast.expr, env: Env) -> Any:
        self.tick()
        t = type(node)
        if t is ast.Constant:
            if type(node.value) not in (int, float, str, bool, type(None)):
                raise LearnerError("unsupported", "Такое значение пока не поддерживается.")
            return node.value
        if t is ast.Name:
            return env.lookup(node.id)
        if t is ast.JoinedStr:
            parts: list[str] = []
            for v in node.values:
                if isinstance(v, ast.Constant):
                    parts.append(str(v.value))
                elif isinstance(v, ast.FormattedValue):
                    if v.format_spec is not None or v.conversion != -1:
                        raise LearnerError("unsupported", "Такое форматирование мы ещё не проходили.")
                    parts.append(str(self.ev(v.value, env)))
            return "".join(parts)
        if t is ast.BinOp:
            return self._binop(node, env)
        if t is ast.UnaryOp:
            v = self.ev(node.operand, env)
            if isinstance(node.op, ast.USub):
                self._need_num(v, "минус")
                return -v
            if isinstance(node.op, ast.Not):
                return not v
            if isinstance(node.op, ast.UAdd):
                self._need_num(v, "плюс")
                return +v
            raise LearnerError("unsupported", "Такой оператор пока не поддерживается.")
        if t is ast.BoolOp:
            if isinstance(node.op, ast.And):
                result: Any = True
                for v in node.values:
                    result = self.ev(v, env)
                    if not result:
                        return result
                return result
            result = False
            for v in node.values:
                result = self.ev(v, env)
                if result:
                    return result
            return result
        if t is ast.Compare:
            left = self.ev(node.left, env)
            for op, comp in zip(node.ops, node.comparators):
                right = self.ev(comp, env)
                fn = _CMPOPS.get(type(op))
                if fn is None:
                    raise LearnerError("unsupported", "Такое сравнение пока не поддерживается.")
                try:
                    ok = fn(left, right)
                except TypeError:
                    raise LearnerError("type", f"Нельзя сравнить {_tn(left)} и {_tn(right)}. Например, число и текст сравнивать нельзя: сначала преобразуй их.")
                if not ok:
                    return False
                left = right
            return True
        if t is ast.IfExp:
            return self.ev(node.body if self.ev(node.test, env) else node.orelse, env)
        if t is ast.List:
            return [self.ev(e, env) for e in node.elts]
        if t is ast.Subscript:
            return self._subscript(node, env)
        if t is ast.Call:
            return self._call(node, env)
        raise LearnerError("unsupported", "Такую конструкцию мы ещё не проходили.")

    def _need_num(self, v: Any, what: str) -> None:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise LearnerError("type", f"К значению типа «{_tn(v)}» нельзя применить {what}.")

    def _binop(self, node: ast.BinOp, env: Env) -> Any:
        a, b = self.ev(node.left, env), self.ev(node.right, env)
        fn = _BINOPS.get(type(node.op))
        if fn is None:
            raise LearnerError("unsupported", "Такой оператор пока не поддерживается.")
        if isinstance(node.op, ast.Mult):
            for seq, n in ((a, b), (b, a)):
                if isinstance(seq, (str, list)) and isinstance(n, int) and not isinstance(n, bool) and len(seq) * max(n, 0) > MAX_SEQ:
                    raise LearnerError("too_slow", "Результат получается слишком большим.")
        if isinstance(node.op, ast.Pow):
            if isinstance(a, (int, float)) and isinstance(b, (int, float)) and (abs(b) > 200 or abs(a) > 10**9):
                raise LearnerError("too_slow", "Число получается слишком большим.")
        try:
            return fn(a, b)
        except ZeroDivisionError:
            raise LearnerError("zero", "На ноль делить нельзя: в программе получилось деление на 0.")
        except TypeError:
            symbol = {ast.Add: "сложить", ast.Sub: "вычесть", ast.Mult: "умножить", ast.Div: "разделить", ast.FloorDiv: "разделить", ast.Mod: "разделить", ast.Pow: "возвести в степень"}[type(node.op)]
            hint = " Преобразуй число в текст через str() или текст в число через int()." if isinstance(node.op, ast.Add) else ""
            raise LearnerError("type", f"Нельзя {symbol}: {_tn(a)} и {_tn(b)} вместе не подходят.{hint}")

    def _subscript(self, node: ast.Subscript, env: Env) -> Any:
        seq = self.ev(node.value, env)
        if not isinstance(seq, (str, list)):
            raise LearnerError("type", f"К значению типа «{_tn(seq)}» нельзя обратиться по номеру.")
        sl = node.slice
        if isinstance(sl, ast.Slice):
            lo = self.ev(sl.lower, env) if sl.lower else None
            hi = self.ev(sl.upper, env) if sl.upper else None
            st = self.ev(sl.step, env) if sl.step else None
            try:
                return seq[lo:hi:st]
            except (TypeError, ValueError):
                raise LearnerError("type", "Границы среза должны быть целыми числами.")
        idx = self.ev(sl, env)
        if isinstance(idx, bool) or not isinstance(idx, int):
            raise LearnerError("type", "Номер элемента должен быть целым числом.")
        try:
            return seq[idx]
        except IndexError:
            raise LearnerError("index", f"Элемента с номером {idx} нет: в {_tn(seq)} всего {len(seq)} элементов (нумерация начинается с 0).")

    # --- вызовы
    def _call(self, node: ast.Call, env: Env) -> Any:
        if node.keywords:
            raise LearnerError("unsupported", "Именованные аргументы мы ещё не проходили.")
        func = node.func
        if isinstance(func, ast.Attribute):
            return self._method(func, node.args, env)
        if not isinstance(func, ast.Name):
            raise LearnerError("unsupported", "Такой вызов пока не поддерживается.")
        args = [self.ev(a, env) for a in node.args]
        name = func.id
        try:
            target = env.lookup(name)
        except LearnerError:
            if name in _BUILTINS:
                return self._builtin(name, args)
            raise LearnerError("name", f"Python не знает функцию «{name}». Проверь, как она пишется, и определена ли она выше.")
        if isinstance(target, Func):
            return self._invoke(target, args)
        if name in _BUILTINS:
            return self._builtin(name, args)
        raise LearnerError("type", f"«{name}» — это не функция, её нельзя вызвать.")

    def _invoke(self, f: Func, args: list[Any]) -> Any:
        if len(args) != len(f.params):
            raise LearnerError("type", f"Функция «{f.name}» ждёт аргументов: {len(f.params)}, а передано: {len(args)}.")
        if self.depth >= MAX_DEPTH:
            raise LearnerError("too_slow", "Функция слишком много раз вызывает сама себя.")
        local = Env(f.env)
        local.vars.update(zip(f.params, args))
        self.depth += 1
        try:
            self.block(f.body, local)
        except _Return as r:
            return r.value
        finally:
            self.depth -= 1
        return None

    def _builtin(self, name: str, a: list[Any]) -> Any:
        try:
            if name == "print":
                self.emit(" ".join(str(x) for x in a))
                return None
            if name == "input":
                if len(a) > 1:
                    raise LearnerError("type", "input() принимает только одну подсказку.")
                if not self.inputs:
                    raise LearnerError("input", "Программа просит ввести данные больше раз, чем ожидалось.")
                return self.inputs.pop(0)
            if name == "int":
                if len(a) != 1:
                    raise LearnerError("type", "int() принимает один аргумент.")
                v = a[0]
                if isinstance(v, str):
                    try:
                        return int(v.strip())
                    except ValueError:
                        raise LearnerError("value", f"Текст «{v}» нельзя превратить в целое число: в нём должны быть только цифры.")
                if isinstance(v, (int, float)):
                    return int(v)
                raise LearnerError("type", f"Из значения типа «{_tn(v)}» нельзя получить целое число.")
            if name == "float":
                v = a[0]
                if isinstance(v, str):
                    try:
                        return float(v.strip().replace(",", "."))
                    except ValueError:
                        raise LearnerError("value", f"Текст «{v}» нельзя превратить в число с точкой.")
                if isinstance(v, (int, float)):
                    return float(v)
                raise LearnerError("type", f"Из значения типа «{_tn(v)}» нельзя получить число.")
            if name == "str":
                return str(a[0]) if a else ""
            if name == "bool":
                return bool(a[0])
            if name == "len":
                if not isinstance(a[0], (str, list)):
                    raise LearnerError("type", f"У значения типа «{_tn(a[0])}» нет длины.")
                return len(a[0])
            if name == "range":
                if not 1 <= len(a) <= 3 or any(isinstance(x, bool) or not isinstance(x, int) for x in a):
                    raise LearnerError("type", "range() принимает от одного до трёх целых чисел.")
                r = range(*a)
                if len(r) > MAX_SEQ:
                    raise LearnerError("too_slow", "Диапазон получается слишком большим.")
                return list(r)
            if name == "abs":
                self._need_num(a[0], "abs()")
                return abs(a[0])
            if name == "round":
                self._need_num(a[0], "round()")
                return round(*a)
            if name in ("max", "min"):
                items = a[0] if len(a) == 1 and isinstance(a[0], (list, str)) else a
                if not items:
                    raise LearnerError("value", f"{name}() не из чего выбирать.")
                return (max if name == "max" else min)(items)
            if name == "sum":
                if not isinstance(a[0], list):
                    raise LearnerError("type", "sum() считает сумму списка чисел.")
                return sum(a[0])
            if name == "sorted":
                if not isinstance(a[0], (list, str)):
                    raise LearnerError("type", "sorted() сортирует список.")
                return sorted(a[0])
            if name == "list":
                return list(a[0]) if a and isinstance(a[0], (str, list)) else []
        except LearnerError:
            raise
        except IndexError:
            raise LearnerError("type", f"Функции «{name}» не хватает аргументов.")
        except (TypeError, ValueError):
            raise LearnerError("type", f"Функция «{name}» получила неподходящие значения.")
        raise LearnerError("unsupported", f"Функцию «{name}» мы ещё не проходили.")

    def _method(self, func: ast.Attribute, arg_nodes: list[ast.expr], env: Env) -> Any:
        obj = self.ev(func.value, env)
        args = [self.ev(a, env) for a in arg_nodes]
        m = func.attr
        allowed = _STR_METHODS if isinstance(obj, str) else _LIST_METHODS if isinstance(obj, list) else set()
        if m not in allowed:
            raise LearnerError("type", f"У значения типа «{_tn(obj)}» нет метода «{m}».")
        try:
            result = getattr(obj, m)(*args)
        except (TypeError, ValueError, IndexError, KeyError) as e:
            raise LearnerError("value", f"Метод «{m}» не сработал: проверь, что в скобках стоят подходящие значения.") from e
        if m in ("sort", "reverse", "append", "insert", "remove"):
            return None
        return result

    # --- операторы
    def block(self, body: list[ast.stmt], env: Env) -> None:
        for stmt in body:
            self.stmt(stmt, env)

    def stmt(self, node: ast.stmt, env: Env) -> None:
        self.tick()
        t = type(node)
        if t is ast.Assign:
            value = self.ev(node.value, env)
            if len(node.targets) != 1:
                raise LearnerError("unsupported", "Такое присваивание мы ещё не проходили.")
            self._assign(node.targets[0], value, env)
        elif t is ast.AugAssign:
            if not isinstance(node.target, ast.Name) or type(node.op) not in _BINOPS:
                raise LearnerError("unsupported", "Такое присваивание мы ещё не проходили.")
            if node.target.id not in env.vars:
                env.lookup(node.target.id)  # может сказать, что имени нет
                raise LearnerError("name", f"Внутри функции нельзя менять «{node.target.id}», пока ей не присвоено значение в этой функции.")
            cur = env.vars[node.target.id]
            rhs = self.ev(node.value, env)
            fake = ast.BinOp(left=ast.Constant(cur), op=node.op, right=ast.Constant(rhs))
            env.vars[node.target.id] = self._binop(fake, env)
        elif t is ast.Expr:
            self.ev(node.value, env)
        elif t is ast.If:
            self.block(node.body if self.ev(node.test, env) else node.orelse, env)
        elif t is ast.While:
            while self.ev(node.test, env):
                try:
                    self.block(node.body, env)
                except _Break:
                    break
                except _Continue:
                    continue
        elif t is ast.For:
            seq = self.ev(node.iter, env)
            if not isinstance(seq, (list, str)):
                raise LearnerError("type", f"По значению типа «{_tn(seq)}» нельзя пройти циклом for.")
            if not isinstance(node.target, ast.Name):
                raise LearnerError("unsupported", "Такой цикл мы ещё не проходили.")
            for item in list(seq):
                env.vars[node.target.id] = item
                try:
                    self.block(node.body, env)
                except _Break:
                    break
                except _Continue:
                    continue
        elif t is ast.FunctionDef:
            if node.decorator_list or node.args.vararg or node.args.kwarg or node.args.kwonlyargs or node.args.defaults:
                raise LearnerError("unsupported", "Такое определение функции мы ещё не проходили.")
            env.vars[node.name] = Func(node.name, [a.arg for a in node.args.args], node.body, env)
        elif t is ast.Return:
            raise _Return(self.ev(node.value, env) if node.value else None)
        elif t is ast.Break:
            raise _Break()
        elif t is ast.Continue:
            raise _Continue()
        elif t is ast.Pass:
            pass
        else:
            raise LearnerError("unsupported", "Такую конструкцию мы ещё не проходили.")

    def _assign(self, target: ast.expr, value: Any, env: Env) -> None:
        if isinstance(target, ast.Name):
            env.vars[target.id] = value
        elif isinstance(target, ast.Subscript):
            seq = self.ev(target.value, env)
            if not isinstance(seq, list):
                raise LearnerError("type", "Менять элементы по номеру можно только в списке.")
            idx = self.ev(target.slice, env)
            if isinstance(idx, bool) or not isinstance(idx, int):
                raise LearnerError("type", "Номер элемента должен быть целым числом.")
            try:
                seq[idx] = value
            except IndexError:
                raise LearnerError("index", f"Элемента с номером {idx} нет в списке.")
        else:
            raise LearnerError("unsupported", "Такое присваивание мы ещё не проходили.")


def run_program(code: str, inputs: list[str] | None = None, max_steps: int = MAX_STEPS) -> RunResult:
    """Выполняет программу в безопасном интерпретаторе. Печать собирается построчно."""
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError, RecursionError):
        return RunResult(error=LearnerError("syntax", "Python не смог прочитать программу: проверь кавычки, скобки и двоеточия."))
    m = _Machine(inputs or [], max_steps)
    error: LearnerError | None = None
    try:
        m.block(tree.body, m.globals)
    except LearnerError as e:
        error = e
    except (_Break, _Continue):
        error = LearnerError("unsupported", "break и continue работают только внутри цикла.")
    except _Return:
        error = LearnerError("unsupported", "return работает только внутри функции.")
    except RecursionError:
        error = LearnerError("too_slow", "Слишком глубокая вложенность.")
    lines: list[str] = []
    for chunk in m.out:
        lines.extend(chunk.split("\\n"))
    return RunResult(output=lines, error=error, globals={k: v for k, v in m.globals.vars.items() if not isinstance(v, Func)})


# ---------------------------------------------------------------- какие возможности языка использует код

def used_features(tree: ast.AST) -> set[str]:
    """Названия возможностей языка, которые встречаются в коде. Нужны для «ещё не проходили»."""
    f: set[str] = set()
    for n in ast.walk(tree):
        t = type(n)
        if t is ast.Assign:
            f.add("assign")
            if any(isinstance(x, ast.Subscript) for x in n.targets):
                f.add("index")
        elif t is ast.AugAssign:
            f.add("augassign")
            f.add("arith")
        elif t is ast.Constant:
            v = n.value
            f.add("bool" if isinstance(v, bool) or v is None else "float" if isinstance(v, float) else "str" if isinstance(v, str) else "int")
        elif t is ast.BinOp:
            f.add("arith2" if isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod, ast.Pow)) else "arith")
        elif t is ast.UnaryOp:
            f.add("logic" if isinstance(n.op, ast.Not) else "arith")
        elif t is ast.JoinedStr:
            f.add("fstring")
        elif t is ast.Call:
            if isinstance(n.func, ast.Attribute):
                f.add("methods")
            elif isinstance(n.func, ast.Name):
                name = n.func.id
                f.add({"print": "print", "input": "input", "int": "convert", "float": "convert", "str": "convert", "bool": "convert", "range": "range", "list": "list"}.get(name, "builtins" if name in _BUILTINS else "call"))
        elif t is ast.Compare:
            f.add("compare")
        elif t is ast.BoolOp:
            f.add("logic")
        elif t is ast.If:
            f.add("if")
        elif t is ast.IfExp:
            f.add("if")
        elif t is ast.For:
            f.add("for")
        elif t is ast.While:
            f.add("while")
        elif t in (ast.Break, ast.Continue):
            f.add("loopctl")
        elif t is ast.List:
            f.add("list")
        elif t is ast.Subscript:
            f.add("index")
        elif t is ast.FunctionDef:
            f.add("def")
        elif t is ast.Return:
            f.add("return")
        elif t is ast.Pass:
            f.add("if")  # pass встречается только внутри блоков
        elif isinstance(n, (ast.Name, ast.Module, ast.Expr, ast.operator, ast.cmpop, ast.boolop, ast.unaryop, ast.arguments, ast.arg, ast.FormattedValue, ast.Slice, ast.Attribute, ast.expr_context)):
            pass
        else:
            f.add("__unsupported__")
    return f
`,o=`"""Нормализация ответов ученика перед сравнением.

Используется и при проверке ответов, и при проверке контента на утечку ответа,
поэтому правила должны быть одинаковыми везде.
"""

from __future__ import annotations

import re
from typing import Literal

MatchMode = Literal["text", "code"]

_SPACES = re.compile(r"\\s+")
_TRAILING_PUNCT = re.compile(r"[.!,;]+$")


def normalize(value: str, mode: MatchMode = "text") -> str:
    """Приводит ответ к виду, в котором его можно сравнивать.

    text: обрезает пробелы, схлопывает повторные пробелы, игнорирует регистр,
          заменяет «ё» на «е», убирает точку/восклицание в конце.
          Кавычки НЕ убираются: ответ "Майкоп" в кавычках — отдельная ошибка.
    code: обрезает пробелы и схлопывает повторные пробелы. Регистр важен.
    """
    result = _SPACES.sub(" ", value.strip())
    if mode == "code":
        return result
    result = result.casefold().replace("ё", "е")
    return _TRAILING_PUNCT.sub("", result).strip()


def contains_answer(text: str, answer: str) -> bool:
    """Есть ли ответ в тексте как отдельное слово или фрагмент кода.

    Используется для проверки утечки ответа: «7» не должно находиться
    в «17», а «age» — в «page». Сравнение без учёта регистра в обоих режимах:
    для утечки важнее поймать лишнее, чем пропустить.
    """
    haystack = normalize(text, "text")
    needle = normalize(answer, "text")
    if not needle:
        return False
    pattern = r"(?<!\\w)" + re.escape(needle) + r"(?!\\w)"
    return re.search(pattern, haystack) is not None
`,s=`"""Свободный запуск кода ученика: «Запустить» без проверки и без влияния на прогресс."""

from __future__ import annotations

from .interp import run_program


def run_snippet(code: str, inputs: list[str] | None = None) -> dict:
    """Выполняет код в безопасном интерпретаторе и возвращает вывод или понятную ошибку.

    Ничего не меняет в состоянии урока: это просто «посмотреть, что получится».
    """
    if not code.strip():
        return {"output": [], "error": "Поле пустое. Напиши программу и нажми «Запустить»."}
    res = run_program(code, list(inputs or []))
    lines = list(res.output)
    while lines and lines[-1] == "":
        lines.pop()
    error = res.error.message if res.error else None
    if res.error and res.error.kind == "input":
        error = "Программа просит ввести данные. Впиши их в поле «Данные для input», по одной строке на каждый input."
    return {"output": lines, "error": error}
`,c={title:`Python с нуля`,content_version:`11eedfa0d3226029`,finale:`Курс пройден! Ты прошёл путь от первой переменной до собственных функций. Все проекты сохранены в разделе «Мои проекты».`,lessons:[{id:`L1`,version:1,title:`Переменные: имя и значение`,welcome:null,features:[`assign`,`int`,`str`,`print`],phrases:{greeting:`Привет! Я твой преподаватель программирования. Учиться будем маленькими шагами: я объясняю одну мысль, показываю короткий пример и задаю один вопрос. Если что-то непонятно — просто напиши об этом, это нормальная часть обучения.`,correct:[`Верно.`,`Да, правильно.`,`Точно.`],correct_after_help:`Верно. Закрепим на новом примере.`,clarify:`Я не совсем понял сообщение. Это ответ на вопрос или мне объяснить по-другому?`,off_topic:`Давай вернёмся к уроку — так ты быстрее дойдёшь до своей первой программы.`,return_to_question:`Вернёмся к вопросу:`,not_learned_yet:`Хороший вопрос, но для этого нужны темы, которых мы ещё не проходили. Мы дойдём до них в следующих уроках.`,dont_know:`Ничего страшного, разберём вместе.`,assessment_help:`Это проверочный вопрос, поэтому ответ я не подскажу. Напомню главное:`,why_fallback:`Хороший вопрос. Чтобы не сбиться, давай сначала закончим этот шаг, а потом вернёмся к нему.`,practice_intro:`Теперь попробуй написать код сам. Пиши прямо в поле в сообщении. Кнопка «Запустить» покажет, что выведет программа, а «Проверить» отправит решение на проверку.`,practice_correct:`Код правильный.`,project_paused:`Для этого шага пригодится тема, которую стоит повторить. Повторим её и сразу вернёмся к проекту.`,project_resumed:`Возвращаемся к проекту.`,concept_mastered:`Тема освоена:`,lesson_complete:`Урок пройден. Ты написал первую программу, которая хранит данные и выводит их на экран.`,how_to_use:`Как это работает. Я объясняю, а ты отвечаешь: нажимай на кнопки с ответами или пиши своими словами в строке внизу. Если что-то непонятно, нажми «Объясни проще», и я объясню по-другому. Ошибаться можно, так и учатся.`,transfer_intro:`Теперь тот же вопрос на новом примере.`,try_again:`Попробуй ещё раз.`,concepts_done:`Все темы урока разобраны. Теперь потренируемся писать код самому.`,practice_retry:`Исправь код и отправь снова.`,hint_no_open:`Сейчас у меня нет открытого вопроса. Можно задать вопрос по теме или нажать «Повтори».`,next_lessons:`Этот урок уже пройден. Любой урок можно повторить: открой «Мой путь» на главном экране.`,review_intro:`Вернёмся к теме «{title}». Сначала напомню главное.`,predict_reveal:`Вот что будет на экране:`,reteach_intro:`Объясню по-другому.`,assignment_intro:`Это тестовое задание. Прочитай условие и требования, а план решения подскажет, с чего начать. Принятое решение попадёт в твоё портфолио.`,warmup_intro:`Впереди тестовое задание, как на собеседовании или от заказчика. Сначала разминка: маленькая задача на ту же тему, чтобы войти в ритм. Подсказка доступна всегда.`,warmup_done:`Разминка пройдена. Теперь само задание.`},concepts:[{id:`C1`,key:`stored_value`,title:`Значение`,goal:`Ученик понимает, что строка age = 7 хранит значение 7.`,explain:`Начнём с самого простого. Программа умеет запоминать значения. Чтобы запомнить значение, ему дают имя и ставят между ними знак =.`,example:`age = 7`,question:{kind:`gating`,format:`choice`,meaning:`Какое значение хранится в age?`,match_mode:`text`,options:[`7`,`age`,`Не знаю`],help_option:`Не знаю`,accept:[`7`,`семь`],misconceptions:[{id:`name_vs_value`,match:[`age`],hint:`age — это имя, под которым программа запомнила значение. Само значение стоит справа от знака =.`,followup:`Какое число стоит справа от знака =?`}],from_example:!1,vocabulary:!1},reteach:`Представь коробку с надписью на крышке. Надпись — это имя, а то, что лежит внутри, — значение. В нашей строке надпись — age, а внутри лежит число, которое стоит справа от знака =.`,walkthrough:`Разберём по шагам. Слева от знака = стоит имя: age. Справа стоит значение: 7. Значит, программа запомнила число 7 под именем age. Теперь проверим это на новом примере.`,alt_examples:[{code:`price = 300`,explain:`Здесь программа запомнила число 300 под именем price.`}],faq:[],transfer_question:{example:`score = 12`,question:{kind:`gating`,format:`input`,meaning:`Какое значение хранится в score?`,match_mode:`text`,options:[],help_option:null,accept:[`12`,`двенадцать`],misconceptions:[{id:`name_vs_value`,match:[`score`],hint:`score — это имя. Значение стоит справа от знака =.`,followup:`Какое число стоит справа от знака =?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C2`,key:`variable_name`,title:`Имя переменной`,goal:`Ученик находит имя переменной: оно стоит слева от знака =.`,explain:`Имя вместе со значением, которое под ним хранится, называется переменной. Имя переменной всегда пишется слева от знака =, а значение — справа.`,example:`age = 7`,question:{kind:`gating`,format:`input`,meaning:`Какое имя у переменной в этой строке?`,match_mode:`text`,options:[],help_option:null,accept:[`age`],misconceptions:[{id:`value_vs_name`,match:[`7`,`семь`],hint:`7 — это значение, то, что хранится. Имя пишется слева от знака =.`,followup:`Какое слово стоит слева от знака =?`}],from_example:!1,vocabulary:!1},reteach:`Вернёмся к коробке: имя — это надпись на крышке. В строке кода надпись всегда стоит в самом начале, до знака =.`,walkthrough:`Читаем строку age = 7 слева направо. Первым идёт слово age — это имя переменной. Потом знак =. Потом значение 7. Значит, имя переменной — age.`,alt_examples:[{code:`height = 180`,explain:`Имя переменной здесь — height, а значение — 180.`}],faq:[],transfer_question:{example:`speed = 60`,question:{kind:`gating`,format:`input`,meaning:`Какое имя у переменной в этой строке?`,match_mode:`text`,options:[],help_option:null,accept:[`speed`],misconceptions:[{id:`value_vs_name`,match:[`60`,`шестьдесят`],hint:`60 — это значение. Имя пишется слева от знака =.`,followup:`Какое слово стоит слева от знака =?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P1`}},{id:`C3`,key:`text_needs_quotes`,title:`Текст в кавычках`,goal:`Ученик понимает, что текстовое значение пишется в кавычках.`,explain:`Значением может быть не только число, но и текст. Текст в Python пишут в кавычках. По кавычкам Python понимает: внутри просто текст, а не имя.`,example:`city = "Майкоп"`,question:{kind:`gating`,format:`choice`,meaning:`Какая строка правильно сохраняет текст Майкоп в переменную city?`,match_mode:`code`,options:[`city = "Майкоп"`,`city = Майкоп`,`Не знаю`],help_option:`Не знаю`,accept:[`city = "Майкоп"`],misconceptions:[{id:`missing_quotes`,match:[`city = Майкоп`],hint:`Без кавычек Python считает слово Майкоп именем другой переменной и ищет её. Такой переменной нет, поэтому программа остановится с ошибкой.`,followup:`В какой из строк слово Майкоп записано как текст?`}],from_example:!1,vocabulary:!1},reteach:`Кавычки — это пометка для Python: «внутри просто текст, ничего не ищи». Если кавычек нет, Python принимает слово за имя переменной.`,walkthrough:`Сравним две строки. В первой слово Майкоп в кавычках — Python видит текст и сохраняет его. Во второй кавычек нет — Python ищет переменную с именем Майкоп и не находит её. Правильная строка: city = "Майкоп".`,alt_examples:[{code:`name = "Анна"`,explain:`Имя Анна записано в кавычках, поэтому Python понимает, что это текст.`}],faq:[{keywords:[`кавычк`],answer:`Кавычки показывают Python, где начинается и где заканчивается текст. Без них Python думает, что слово — это имя переменной.`}],transfer_question:{example:`food = ____`,question:{kind:`gating`,format:`input`,meaning:`Напиши строку, которая сохраняет текст плов в переменную food.`,match_mode:`code`,options:[],help_option:null,accept:[`food = "плов"`,`food = 'плов'`],misconceptions:[{id:`missing_quotes`,match:[`food = плов`],hint:`Слово плов здесь — текст, а текст пишется в кавычках.`,followup:`Напиши эту строку ещё раз, с кавычками вокруг текста.`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`independent`],after_error:[`transfer`],independent_task:`P3`}},{id:`C4`,key:`print_shows_value`,title:`Вывод на экран`,goal:`Ученик понимает, что print(age) показывает значение, а не имя.`,explain:`Чтобы увидеть значение, его выводят на экран командой print. В скобках пишут имя переменной, а на экране появляется то, что в ней хранится.`,example:`age = 7
print(age)`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране после этих двух строк?`,match_mode:`text`,options:[`7`,`age`,`print(age)`,`Не знаю`],help_option:`Не знаю`,accept:[`7`,`семь`],misconceptions:[{id:`prints_name`,match:[`age`],hint:`print не показывает само имя. Он находит переменную age и показывает, что в ней лежит.`,followup:`Какое значение лежит в переменной age?`},{id:`prints_code`,match:[`print(age)`],hint:`Команда print не печатает саму себя. Она выполняется и показывает значение переменной из скобок.`,followup:`Какое значение лежит в переменной age?`}],from_example:!1,vocabulary:!1},reteach:`print — это просьба: «покажи, что лежит в коробке с этой надписью». На экране появляется содержимое коробки, а не надпись на ней.`,walkthrough:`Шаг первый: age = 7 — программа запоминает 7 под именем age. Шаг второй: print(age) — программа берёт значение из age и показывает его. На экране будет 7.`,alt_examples:[{code:`price = 300
print(price)`,explain:`На экране появится 300 — значение переменной price.`}],faq:[],transfer_question:{example:`score = 12
print(score)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`12`,`двенадцать`],misconceptions:[{id:`prints_name`,match:[`score`],hint:`print показывает не имя, а значение переменной score.`,followup:`Какое значение хранится в score?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C5`,key:`print_text_variable`,title:`Вывод текста`,goal:`Ученик понимает, что print выводит текст без кавычек.`,explain:`Текстовую переменную выводят так же, через print. Кавычки нужны только внутри программы, чтобы Python понял, где текст. На экран они не попадают.`,example:`city = "Майкоп"
print(city)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши точно так, как это будет выглядеть.`,match_mode:`text`,options:[],help_option:null,accept:[`Майкоп`],misconceptions:[{id:`quotes_printed`,match:[`"Майкоп"`,`'Майкоп'`,`«Майкоп»`],hint:`Почти. Кавычки нужны Python, чтобы понять, где текст. На экране их не будет.`,followup:`Как это слово будет выглядеть на экране без кавычек?`},{id:`prints_name`,match:[`city`],hint:`print показывает не имя, а текст, который хранится в переменной city.`,followup:`Какой текст хранится в city?`}],from_example:!1,vocabulary:!1},reteach:`На экран выводится содержимое переменной. Кавычки — служебная пометка для Python, как рамка вокруг текста. Сам текст выводится без рамки.`,walkthrough:`Шаг первый: city = "Майкоп" — программа запоминает текст Майкоп, кавычки показывают, где он начинается и заканчивается. Шаг второй: print(city) — программа показывает этот текст. На экране будет Майкоп, без кавычек.`,alt_examples:[{code:`name = "Анна"
print(name)`,explain:`На экране появится Анна — без кавычек.`}],faq:[],transfer_question:{example:`pet = "кот"
print(pet)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`кот`],misconceptions:[{id:`quotes_printed`,match:[`"кот"`,`'кот'`,`«кот»`],hint:`Кавычки остаются внутри программы, на экран они не попадают.`,followup:`Как будет выглядеть это слово на экране?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P4`}}],practice:[{id:`P1`,ladder_step:3,mode:`guided`,concepts:[`C2`,`C3`],prompt:`Заполни пропуск: впиши своё имя между кавычками вместо подчёркиваний.`,starter_code:`name = "____"`,expected:[{kind:`assign`,name:`name`,value_type:`str`,non_empty:!0,int_min:null,int_max:null}],tests:[],must_use:[],max_lines:1,hint:`Убери подчёркивания и напиши на их месте своё имя. Кавычки оставь.`,example:`name = "Олег"`},{id:`P2`,ladder_step:4,mode:`guided`,concepts:[`C1`],prompt:`Вот готовая строка. Измени её так, чтобы в age хранился твой возраст.`,starter_code:`age = 7`,expected:[{kind:`assign`,name:`age`,value_type:`int`,non_empty:!1,int_min:1,int_max:120}],tests:[],must_use:[],max_lines:1,hint:`Поменяй только число справа от знака =. Кавычки не нужны: возраст — это число.`,example:`age = 35`},{id:`P3`,ladder_step:5,mode:`guided`,concepts:[`C3`],prompt:`Напиши одну строку: сохрани свой город в переменную city.`,starter_code:null,expected:[{kind:`assign`,name:`city`,value_type:`str`,non_empty:!0,int_min:null,int_max:null}],tests:[],must_use:[],max_lines:1,hint:`Начни с имени city, потом знак =, потом название города в кавычках.`,example:`city = "Казань"`},{id:`P4`,ladder_step:6,mode:`independent`,concepts:[`C4`,`C5`],prompt:`Напиши две строки: сохрани свою любимую еду в переменную food, а затем выведи её на экран.`,starter_code:null,expected:[{kind:`assign`,name:`food`,value_type:`str`,non_empty:!0,int_min:null,int_max:null},{kind:`print`,name:`food`,value_type:null,non_empty:!1,int_min:null,int_max:null}],tests:[],must_use:[],max_lines:2,hint:`Первая строка устроена так же, как строка с city. Во второй используй print и имя переменной в скобках, без кавычек.`,example:null}],project:{id:`MP1`,title:`Карточка пользователя`,intro:`Теперь соберём твою первую программу — карточку пользователя. Она будет хранить имя, город и возраст и выводить их на экран. Будем добавлять по одной строке.`,max_lines:6,steps:[{id:`M1`,kind:`code`,prompt:`Создай переменную name и сохрани в неё своё имя.`,requires:[`C3`],adds:[{kind:`assign`,name:`name`,value_type:`str`,non_empty:!0,int_min:null,int_max:null}],tests:[],must_use:[],inputs:[],hint:`Имя — это текст, поэтому оно пишется в кавычках.`},{id:`M2`,kind:`code`,prompt:`Добавь вторую строку: переменную city с твоим городом.`,requires:[`C3`],adds:[{kind:`assign`,name:`city`,value_type:`str`,non_empty:!0,int_min:null,int_max:null}],tests:[],must_use:[],inputs:[],hint:`Первую строку оставь как есть, новую напиши под ней.`},{id:`M3`,kind:`code`,prompt:`Добавь переменную age со своим возрастом.`,requires:[`C1`],adds:[{kind:`assign`,name:`age`,value_type:`int`,non_empty:!1,int_min:1,int_max:120}],tests:[],must_use:[],inputs:[],hint:`Возраст — это число, поэтому кавычки не нужны.`},{id:`M4`,kind:`code`,prompt:`Выведи все три значения на экран, каждое отдельной строкой.`,requires:[`C4`,`C5`],adds:[{kind:`print`,name:`name`,value_type:null,non_empty:!1,int_min:null,int_max:null},{kind:`print`,name:`city`,value_type:null,non_empty:!1,int_min:null,int_max:null},{kind:`print`,name:`age`,value_type:null,non_empty:!1,int_min:null,int_max:null}],tests:[],must_use:[],inputs:[],hint:`Для каждой переменной нужна своя строка с print и её именем в скобках.`},{id:`M5`,kind:`predict_output`,prompt:`Посмотри на свою программу и напиши, что она покажет на экране. Каждое значение — с новой строки.`,requires:[`C5`],adds:[],tests:[],must_use:[],inputs:[],hint:`Иди по строкам с print сверху вниз и вспомни, что хранится в каждой переменной.`}],outro:`Готово: это твоя первая программа. Она хранит данные и показывает их на экране — с этого начинается почти любая программа.`},assignment:{id:`T1`,title:`Профиль участника`,level:`Лёгкое`,summary:`Хранит данные профиля в переменных и выводит их по одному на строку.`,brief:`Заказчик: онлайн-кружок рисования. Нужна заготовка программы для профиля участника. Данные должны храниться в переменных, а программа выводит их на экран.

Участница: Мария, город Казань, любимое занятие — рисование, возраст 28 лет.`,requirements:[`Сохрани в переменные name, city, hobby и age значения из условия (имя, город и занятие — текст, возраст — число)`,`Выведи значения этих переменных на экран, каждое на отдельной строке, в таком порядке: name, city, hobby, age`,`Выводи именно переменные, а не готовые слова в print`],plan:[`Запиши четыре переменные: name, city, hobby и age.`,`Текст бери в кавычки, возраст пиши числом без кавычек.`,`Выведи каждую переменную отдельной строкой print, по имени, без кавычек.`],warmup:{prompt:`Сохрани название города «Казань» в переменную city и выведи её на экран.`,tests:[{inputs:[],output:[`Казань`],call:null}],must_use:[`assign`],max_lines:3,hint:`Сначала строка с кавычками: city = "Казань". Потом print(city).`},tests:[{inputs:[],output:[`Мария`,`Казань`,`рисование`,`28`],call:null}],must_use:[`assign`],max_lines:8,hint:`Сначала четыре строки с переменными (текст — в кавычках, число — без), потом четыре строки print с именами переменных.`},code_feedback:{syntax_error:`Python не смог прочитать эту строку. Чаще всего не хватает кавычки или скобки — проверь, что у каждой открывающей есть закрывающая.`,too_many_lines:`Здесь нужно меньше строк. Оставь только то, о чём просит задание.`,not_learned_yet:`В коде есть то, что мы ещё не проходили. Попробуй решить задание тем, что уже знаешь.`,missing_assignment:`Не вижу строки, где значение сохраняется в нужную переменную.`,wrong_variable_name:`Имя переменной отличается от того, что в задании. Проверь, как оно пишется.`,missing_quotes:`Без кавычек Python считает слово именем другой переменной и ищет её. Текст нужно взять в кавычки.`,empty_text:`Между кавычками пусто. Напиши текст внутри них.`,string_instead_of_number:`Число в кавычках Python считает текстом. Здесь нужно именно число, поэтому кавычки не нужны.`,number_instead_of_string:`Здесь нужен текст, поэтому значение пишется в кавычках.`,number_out_of_range:`Число выглядит необычно для этого задания. Проверь его ещё раз.`,missing_print:`Значение сохранено, но на экран оно не выводится. Для этого нужен print.`,printed_literal_instead_of_variable:`В скобках print стоит текст в кавычках, поэтому на экран выведется само это слово. Чтобы вывести значение переменной, напиши её имя без кавычек.`,unchanged_starter:`Строка пока осталась такой же, как была. Измени её по заданию.`,wrong_output:`Программа работает, но результат не тот, что нужен. Сравни, что ожидалось и что получилось.`,runtime_error:`Программа остановилась с ошибкой. Прочитай, что случилось, и исправь это место.`,too_slow:`Программа не закончила работу. Скорее всего, цикл никогда не останавливается.`,missing_construct:`Задание нужно решить с помощью темы урока. Посмотри, что именно требуется.`,empty_code:`Поле пустое. Напиши программу по заданию и нажми «Проверить».`}},{id:`L2`,version:1,title:`Числа и арифметика`,welcome:`Урок 2. В первом уроке ты научился хранить значения и выводить их. Теперь научим программу считать: Python умеет это не хуже калькулятора. Как и раньше: я объясняю одну мысль, показываю пример и задаю вопрос.`,features:[`arith`,`arith2`,`float`,`augassign`],phrases:{greeting:`Привет! Я твой преподаватель программирования. Учиться будем маленькими шагами: я объясняю одну мысль, показываю короткий пример и задаю один вопрос. Если что-то непонятно — просто напиши об этом, это нормальная часть обучения.`,correct:[`Верно.`,`Да, правильно.`,`Точно.`],correct_after_help:`Верно. Закрепим на новом примере.`,clarify:`Я не совсем понял сообщение. Это ответ на вопрос или мне объяснить по-другому?`,off_topic:`Давай вернёмся к уроку — так ты быстрее дойдёшь до своей первой программы.`,return_to_question:`Вернёмся к вопросу:`,not_learned_yet:`Хороший вопрос, но для этого нужны темы, которых мы ещё не проходили. Мы дойдём до них в следующих уроках.`,dont_know:`Ничего страшного, разберём вместе.`,assessment_help:`Это проверочный вопрос, поэтому ответ я не подскажу. Напомню главное:`,why_fallback:`Хороший вопрос. Чтобы не сбиться, давай сначала закончим этот шаг, а потом вернёмся к нему.`,practice_intro:`Теперь попробуй написать код сам. Пиши прямо в поле в сообщении. Кнопка «Запустить» покажет, что выведет программа, а «Проверить» отправит решение на проверку.`,practice_correct:`Код правильный.`,project_paused:`Для этого шага пригодится тема, которую стоит повторить. Повторим её и сразу вернёмся к проекту.`,project_resumed:`Возвращаемся к проекту.`,concept_mastered:`Тема освоена:`,lesson_complete:`Урок пройден. Теперь твои программы умеют считать и обновлять значения.`,how_to_use:`Как это работает. Я объясняю, а ты отвечаешь: нажимай на кнопки с ответами или пиши своими словами в строке внизу. Если что-то непонятно, нажми «Объясни проще», и я объясню по-другому. Ошибаться можно, так и учатся.`,transfer_intro:`Теперь тот же вопрос на новом примере.`,try_again:`Попробуй ещё раз.`,concepts_done:`Все темы урока разобраны. Теперь потренируемся писать код самому.`,practice_retry:`Исправь код и отправь снова.`,hint_no_open:`Сейчас у меня нет открытого вопроса. Можно задать вопрос по теме или нажать «Повтори».`,next_lessons:`Этот урок уже пройден. Любой урок можно повторить: открой «Мой путь» на главном экране.`,review_intro:`Вернёмся к теме «{title}». Сначала напомню главное.`,predict_reveal:`Вот что будет на экране:`,reteach_intro:`Объясню по-другому.`,assignment_intro:`Это тестовое задание. Прочитай условие и требования, а план решения подскажет, с чего начать. Принятое решение попадёт в твоё портфолио.`,warmup_intro:`Впереди тестовое задание, как на собеседовании или от заказчика. Сначала разминка: маленькая задача на ту же тему, чтобы войти в ритм. Подсказка доступна всегда.`,warmup_done:`Разминка пройдена. Теперь само задание.`},concepts:[{id:`C1`,key:`basic_arithmetic`,title:`Сложение, вычитание, умножение`,goal:`Ученик понимает, что print считает выражение и показывает результат.`,explain:`Python умеет считать. Для сложения есть знак +, для вычитания — знак -, а для умножения — звёздочка *. Выражение в скобках print сначала считается, и только потом результат появляется на экране.`,example:`print(5 + 3)`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`8`,`53`,`5 + 3`,`Не знаю`],help_option:`Не знаю`,accept:[`8`,`восемь`],misconceptions:[{id:`printed_expression`,match:[`5 + 3`],hint:`print не показывает сам пример. Он сначала считает, а потом выводит итог.`,followup:`Чему равна сумма пяти и трёх?`},{id:`glued_numbers`,match:[`53`],hint:`Знак + между числами складывает их, а не приписывает одно к другому.`,followup:`Чему равна сумма пяти и трёх?`}],from_example:!1,vocabulary:!1},reteach:`Python считает так же, как калькулятор: ты вводишь пример, он выдаёт итог. print показывает только итог, а не сам пример.`,walkthrough:`Разберём. Python видит 5 + 3 и считает: получается 8. Затем print показывает это число. Значит, на экране будет 8.`,alt_examples:[{code:`print(10 - 4)`,explain:`Python вычтет и покажет 6.`}],faq:[{keywords:[`звёздоч`,`звездоч`,`умнож`],answer:`Умножение в Python записывается звёздочкой: 3 * 4 даст 12. Знака × на клавиатуре нет.`}],transfer_question:{example:`print(9 - 4)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`5`,`пять`],misconceptions:[{id:`printed_expression`,match:[`9 - 4`],hint:`print сначала считает, а потом показывает итог, а не сам пример.`,followup:`Чему равна разность девяти и четырёх?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C2`,key:`arithmetic_with_variables`,title:`Вычисления с переменными`,goal:`Ученик понимает, что в выражении вместо имени переменной берётся её значение.`,explain:`Считать можно и с переменными. Python подставляет вместо имени значение, которое в нём хранится. Так число записывают один раз и используют сколько угодно.`,example:`apples = 4
pears = 5
print(apples + pears)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`9`,`девять`],misconceptions:[{id:`glued_numbers`,match:[`45`],hint:`Знак + между числами складывает их, а не приписывает одно к другому.`,followup:`Какие значения лежат в двух переменных и чему равна их сумма?`},{id:`printed_expression`,match:[`apples + pears`],hint:`print показывает результат вычисления, а не само выражение.`,followup:`Какое число получится, если сложить значения обеих переменных?`}],from_example:!0,vocabulary:!1},reteach:`Имя переменной в вычислении — это просто замена значению. Вместо имени Python берёт число, которое в ней лежит, и считает как обычно.`,walkthrough:`Шаг за шагом. В apples лежит 4, в pears лежит 5. Выражение apples + pears превращается в 4 + 5. Сумма равна 9. Её и покажет print.`,alt_examples:[{code:`width = 3
height = 8
print(width * height)`,explain:`Python подставит 3 и 8, перемножит и покажет 24.`}],faq:[],transfer_question:{example:`boxes = 7
items = 6
print(boxes * items)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`42`],misconceptions:[{id:`printed_expression`,match:[`boxes * items`],hint:`print показывает результат вычисления, а не само выражение.`,followup:`Какое число получится при умножении значений двух переменных?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P2`}},{id:`C3`,key:`division`,title:`Деление: / и //`,goal:`Ученик различает точное деление / и целую часть //.`,explain:`Деление записывается знаком /. Результат всегда получается с точкой, например 2.5. Если нужна только целая часть, ставят два слеша //: они отбрасывают дробную часть.`,example:`print(9 / 2)
print(9 // 2)`,question:{kind:`gating`,format:`choice`,meaning:`Что покажет вторая строка, print(9 // 2)?`,match_mode:`text`,options:[`4`,`4.5`,`5`,`Не знаю`],help_option:`Не знаю`,accept:[`4`,`четыре`],misconceptions:[{id:`fraction_kept`,match:[`4.5`],hint:`Два слеша отбрасывают дробную часть. Дробь с точкой даёт одинарный слеш.`,followup:`Сколько целых раз двойка помещается в девятке?`},{id:`rounded_up`,match:[`5`],hint:`Округления вверх здесь нет: // просто отбрасывает дробную часть.`,followup:`Сколько полных двоек можно набрать из девяти?`}],from_example:!1,vocabulary:!1},reteach:`Представь, что делишь конфеты между детьми. Знак / считает точно, вместе с дробной частью. Знак // считает, сколько целых конфет досталось каждому.`,walkthrough:`Первая строка: 9 / 2 даёт 4.5. Вторая строка: 9 // 2 отбрасывает дробную часть .5, остаётся 4. Значит, ответ — 4.`,alt_examples:[{code:`print(10 / 4)
print(10 // 4)`,explain:`Первая строка покажет 2.5, вторая — только целую часть: 2.`}],faq:[{keywords:[`слеш`,`слэш`,`наклон`],answer:`Слеш — это косая черта /. Одна даёт точное деление, две подряд — целую часть.`}],transfer_question:{example:`print(17 / 5)
print(17 // 5)`,question:{kind:`gating`,format:`input`,meaning:`Что покажет вторая строка, print(17 // 5)?`,match_mode:`text`,options:[],help_option:null,accept:[`3`,`три`],misconceptions:[{id:`fraction_kept`,match:[`3.4`,`3,4`],hint:`Два слеша отбрасывают дробную часть, остаётся только целое.`,followup:`Сколько полных пятёрок помещается в семнадцати?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C4`,key:`remainder`,title:`Остаток от деления %`,goal:`Ученик понимает, что % даёт остаток.`,explain:`Знак % в Python не про проценты. Он показывает остаток от деления: сколько осталось после того, как забрали все целые части.`,example:`print(17 % 5)`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`2`,`3`,`3.4`,`Не знаю`],help_option:`Не знаю`,accept:[`2`,`два`],misconceptions:[{id:`whole_parts`,match:[`3`],hint:`Это число показывает, сколько раз пятёрка помещается целиком. А знак % показывает то, что осталось.`,followup:`Что останется, когда заберут все полные пятёрки?`},{id:`fraction_instead`,match:[`3.4`],hint:`Дробь даёт знак /. А знак % показывает остаток.`,followup:`Что останется после того, как заберут все полные пятёрки?`}],from_example:!1,vocabulary:!1},reteach:`Раздай 17 конфет по 5 в пакетик. Полные пакетики набрались, а несколько конфет в них не поместились. Эти оставшиеся конфеты и есть остаток.`,walkthrough:`Пятёрка помещается в семнадцати три раза, это 15. До семнадцати не хватает 2. Значит, остаток равен 2.`,alt_examples:[{code:`print(13 % 4)`,explain:`Сначала забираем все полные четвёрки, а то, что не поместилось, и есть ответ. На экране будет 1.`}],faq:[{keywords:[`процент`],answer:`Проценты тут ни при чём. Знак % у программистов означает «остаток от деления».`}],transfer_question:{example:`print(23 % 5)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`3`,`три`],misconceptions:[{id:`whole_parts`,match:[`4`,`четыре`],hint:`Это сколько раз пятёрка помещается целиком. Знак % показывает остаток.`,followup:`Сколько остаётся после того, как забрали все полные пятёрки?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C5`,key:`update_variable`,title:`Обновление переменной`,goal:`Ученик понимает, что score = score + 5 читает старое значение и сохраняет новое.`,explain:`Значение переменной можно менять. Строка score = score + 5 читается так: взять то, что лежит в score, прибавить 5 и снова сохранить в score. Есть короткая запись score += 5, она делает то же самое.`,example:`score = 10
score = score + 5
print(score)`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`15`,`10`,`5`,`Не знаю`],help_option:`Не знаю`,accept:[`15`],misconceptions:[{id:`old_value`,match:[`10`],hint:`Вторая строка меняет значение: Python берёт старое, прибавляет и сохраняет новое под тем же именем.`,followup:`Что лежит в score после второй строки?`},{id:`replaced_value`,match:[`5`],hint:`Число прибавляется к тому, что уже было в score, а не заменяет его.`,followup:`Сколько было в score до прибавления?`}],from_example:!1,vocabulary:!1},reteach:`Переменная — как коробка. Строка достаёт из коробки старое число, прибавляет к нему ещё, и кладёт обратно уже новое число.`,walkthrough:`Сначала в score лежит 10. Вторая строка берёт 10, прибавляет 5 и кладёт обратно. Теперь в score лежит 15, его и показывает print.`,alt_examples:[{code:`coins = 20
coins -= 6
print(coins)`,explain:`Запись -= вычитает из переменной. В coins останется 14.`}],faq:[{keywords:[`+=`,`плюс равно`],answer:`Запись x += 1 — сокращение от x = x + 1. Так же работают -=, *= и другие.`}],transfer_question:{example:`coins = 3
coins += 4
print(coins)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`7`,`семь`],misconceptions:[{id:`old_value`,match:[`3`,`три`],hint:`Строка coins += 4 меняет значение: к старому прибавляется 4.`,followup:`Что лежит в coins после этой строки?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`independent`],after_error:[`transfer`],independent_task:`P3`}}],practice:[{id:`P1`,ladder_step:1,mode:`guided`,concepts:[`C1`],prompt:`Выведи на экран результат умножения 12 на 15.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`180`],call:null}],must_use:[`arith`],max_lines:1,hint:`Напиши print, а в скобках — пример с умножением: два числа и звёздочка между ними.`,example:`print(3 * 4)`},{id:`P2`,ladder_step:2,mode:`independent`,concepts:[`C2`],prompt:`Заготовка уже хранит ширину и высоту прямоугольника. Допиши строку, которая выводит площадь (ширина, умноженная на высоту).`,starter_code:`width = 8
height = 5`,expected:[],tests:[{inputs:[],output:[`40`],call:null}],must_use:[`arith`],max_lines:3,hint:`Внутри print перемножь две переменные по их именам, без кавычек.`,example:`a = 2
b = 9
print(a * b)`},{id:`P3`,ladder_step:3,mode:`independent`,concepts:[`C5`],prompt:`Сохрани в переменную points число 10. Затем прибавь к ней 7 и выведи результат.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`17`],call:null}],must_use:[`arith`],max_lines:4,hint:`Три шага: создать points, обновить её (points = points + 7 или короче points += 7) и вывести через print.`,example:`level = 1
level += 2
print(level)`},{id:`P4`,ladder_step:4,mode:`guided`,concepts:[`C3`,`C4`],prompt:`Выведи на экран две строки: сначала целую часть от деления 50 на 7, потом остаток от этого деления.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`7`,`1`],call:null}],must_use:[`arith2`],max_lines:2,hint:`Целую часть даёт //, остаток даёт %. Каждое выражение — в своём print.`,example:`print(20 // 6)
print(20 % 6)`}],project:{id:`MP2`,title:`Чек в магазине`,intro:`Соберём программу, которая считает стоимость покупки и сдачу. Будем добавлять по одной мысли и после каждого шага проверять результат.`,max_lines:12,steps:[{id:`M1`,kind:`code`,prompt:`Сохрани в переменную price цену одной тетради: 40.`,requires:[`C2`],adds:[],tests:[{inputs:[],output:[`40`],call:`print(price)`}],must_use:[],inputs:[],hint:`Имя price, знак =, потом число без кавычек.`},{id:`M2`,kind:`code`,prompt:`Добавь переменную count — сколько тетрадей купили: 6.`,requires:[`C2`],adds:[],tests:[{inputs:[],output:[`6`],call:`print(count)`}],must_use:[],inputs:[],hint:`Новую строку напиши под первой.`},{id:`M3`,kind:`code`,prompt:`Добавь переменную total — стоимость покупки: цена, умноженная на количество.`,requires:[`C2`],adds:[],tests:[{inputs:[],output:[`240`],call:`print(total)`}],must_use:[`arith`],inputs:[],hint:`Справа от знака = перемножь price и count по именам.`},{id:`M4`,kind:`code`,prompt:`Покупатель дал 500. Добавь переменную change — сдачу: 500 минус total.`,requires:[`C1`,`C2`],adds:[],tests:[{inputs:[],output:[`260`],call:`print(change)`}],must_use:[],inputs:[],hint:`Из числа 500 вычти переменную total.`},{id:`M5`,kind:`code`,prompt:`Выведи на экран total и change, каждое на своей строке.`,requires:[`C2`],adds:[],tests:[{inputs:[],output:[`240`,`260`],call:null}],must_use:[],inputs:[],hint:`Два print: в первом total, во втором change.`},{id:`M6`,kind:`code`,prompt:`Покупатель взял ещё 2 тетради. Добавь строку count += 2, пересчитай total и выведи его ещё раз.`,requires:[`C5`],adds:[],tests:[{inputs:[],output:[`240`,`260`,`320`],call:null}],must_use:[`augassign`],inputs:[],hint:`После count += 2 нужно заново посчитать total (та же формула), и только потом print(total).`},{id:`M7`,kind:`predict_output`,prompt:`Посмотри на программу и напиши, что она покажет на экране. Каждое значение — с новой строки.`,requires:[`C5`],adds:[],tests:[],must_use:[],inputs:[],hint:`Иди сверху вниз и следи, как меняются count и total.`}],outro:`Готово: программа посчитала покупку, сдачу и пересчитала сумму после изменения. Так работают настоящие кассовые программы.`},assignment:{id:`T2`,title:`Расчёт стоимости поездки на такси`,level:`Лёгкое`,summary:`Считает стоимость поездки по тарифу и сдачу с купюры.`,brief:`Заказчик: служба такси. Нужна программа, которая считает стоимость поездки: фиксированная плата за посадку плюс оплата за каждый километр.

Тариф: дальность поездки 12 км, цена километра 25 рублей, посадка 100 рублей. Пассажир платит купюрой 500 рублей.

Ожидаемый вывод:
Стоимость поездки: 400
Из них за километры: 300
Сдача с 500: 100`,requirements:[`Запиши тариф в переменные distance, rate и boarding; в print не подставляй готовые числа`,`Посчитай стоимость поездки: посадка плюс километры, умноженные на цену километра`,`Выведи три строки в точности как в примере (двоеточие и пробел после текста)`,`Сдачу считай от 500 рублей`],plan:[`Сохрани distance, rate и boarding в переменные.`,`Посчитай стоимость километров и итог, каждое в своей переменной.`,`Выведи три строки через print с текстом и значением: print("Стоимость поездки:", total).`,`Сдачу считай как 500 минус итоговая стоимость.`],warmup:{prompt:`Цена одной тетради 120 рублей, ты берёшь 3 штуки. Сохрани цену в price, количество в count и выведи общую стоимость (число).`,tests:[{inputs:[],output:[`360`],call:null}],must_use:[`arith`],max_lines:4,hint:`Выведи произведение: print(price * count).`},tests:[{inputs:[],output:[`Стоимость поездки: 400`,`Из них за километры: 300`,`Сдача с 500: 100`],call:null}],must_use:[`arith`],max_lines:10,hint:`Сохрани итог в переменную total. print умеет выводить несколько значений через запятую: print("Стоимость поездки:", total).`},code_feedback:{syntax_error:`Python не смог прочитать эту строку. Чаще всего не хватает кавычки или скобки — проверь, что у каждой открывающей есть закрывающая.`,too_many_lines:`Здесь нужно меньше строк. Оставь только то, о чём просит задание.`,not_learned_yet:`В коде есть то, что мы ещё не проходили. Попробуй решить задание тем, что уже знаешь.`,missing_assignment:`Не вижу строки, где значение сохраняется в нужную переменную.`,wrong_variable_name:`Имя переменной отличается от того, что в задании. Проверь, как оно пишется.`,missing_quotes:`Без кавычек Python считает слово именем другой переменной и ищет её. Текст нужно взять в кавычки.`,empty_text:`Между кавычками пусто. Напиши текст внутри них.`,string_instead_of_number:`Число в кавычках Python считает текстом. Здесь нужно именно число, поэтому кавычки не нужны.`,number_instead_of_string:`Здесь нужен текст, поэтому значение пишется в кавычках.`,number_out_of_range:`Число выглядит необычно для этого задания. Проверь его ещё раз.`,missing_print:`Значение сохранено, но на экран оно не выводится. Для этого нужен print.`,printed_literal_instead_of_variable:`В скобках print стоит текст в кавычках, поэтому на экран выведется само это слово. Чтобы вывести значение переменной, напиши её имя без кавычек.`,unchanged_starter:`Строка пока осталась такой же, как была. Измени её по заданию.`,wrong_output:`Программа работает, но результат не тот, что нужен. Сравни, что ожидалось и что получилось.`,runtime_error:`Программа остановилась с ошибкой. Прочитай, что случилось, и исправь это место.`,too_slow:`Программа не закончила работу. Скорее всего, цикл никогда не останавливается.`,missing_construct:`Задание нужно решить с помощью темы урока. Посмотри, что именно требуется.`,empty_code:`Поле пустое. Напиши программу по заданию и нажми «Проверить».`}},{id:`L3`,version:1,title:`Текст`,welcome:`Урок 3. До сих пор мы работали в основном с числами. Теперь займёмся текстом: научимся склеивать слова, подставлять значения в фразы и выполнять над текстом готовые команды.`,features:[`fstring`,`methods`,`builtins`,`index`],phrases:{greeting:`Привет! Я твой преподаватель программирования. Учиться будем маленькими шагами: я объясняю одну мысль, показываю короткий пример и задаю один вопрос. Если что-то непонятно — просто напиши об этом, это нормальная часть обучения.`,correct:[`Верно.`,`Да, правильно.`,`Точно.`],correct_after_help:`Верно. Закрепим на новом примере.`,clarify:`Я не совсем понял сообщение. Это ответ на вопрос или мне объяснить по-другому?`,off_topic:`Давай вернёмся к уроку — так ты быстрее дойдёшь до своей первой программы.`,return_to_question:`Вернёмся к вопросу:`,not_learned_yet:`Хороший вопрос, но для этого нужны темы, которых мы ещё не проходили. Мы дойдём до них в следующих уроках.`,dont_know:`Ничего страшного, разберём вместе.`,assessment_help:`Это проверочный вопрос, поэтому ответ я не подскажу. Напомню главное:`,why_fallback:`Хороший вопрос. Чтобы не сбиться, давай сначала закончим этот шаг, а потом вернёмся к нему.`,practice_intro:`Теперь попробуй написать код сам. Пиши прямо в поле в сообщении. Кнопка «Запустить» покажет, что выведет программа, а «Проверить» отправит решение на проверку.`,practice_correct:`Код правильный.`,project_paused:`Для этого шага пригодится тема, которую стоит повторить. Повторим её и сразу вернёмся к проекту.`,project_resumed:`Возвращаемся к проекту.`,concept_mastered:`Тема освоена:`,lesson_complete:`Урок пройден. Теперь ты умеешь собирать фразы из кусочков и менять текст.`,how_to_use:`Как это работает. Я объясняю, а ты отвечаешь: нажимай на кнопки с ответами или пиши своими словами в строке внизу. Если что-то непонятно, нажми «Объясни проще», и я объясню по-другому. Ошибаться можно, так и учатся.`,transfer_intro:`Теперь тот же вопрос на новом примере.`,try_again:`Попробуй ещё раз.`,concepts_done:`Все темы урока разобраны. Теперь потренируемся писать код самому.`,practice_retry:`Исправь код и отправь снова.`,hint_no_open:`Сейчас у меня нет открытого вопроса. Можно задать вопрос по теме или нажать «Повтори».`,next_lessons:`Этот урок уже пройден. Любой урок можно повторить: открой «Мой путь» на главном экране.`,review_intro:`Вернёмся к теме «{title}». Сначала напомню главное.`,predict_reveal:`Вот что будет на экране:`,reteach_intro:`Объясню по-другому.`,assignment_intro:`Это тестовое задание. Прочитай условие и требования, а план решения подскажет, с чего начать. Принятое решение попадёт в твоё портфолио.`,warmup_intro:`Впереди тестовое задание, как на собеседовании или от заказчика. Сначала разминка: маленькая задача на ту же тему, чтобы войти в ритм. Подсказка доступна всегда.`,warmup_done:`Разминка пройдена. Теперь само задание.`},concepts:[{id:`C1`,key:`concatenation`,title:`Склейка текста`,goal:`Ученик понимает, что + склеивает тексты вплотную, без пробела.`,explain:`Тексты можно склеивать знаком +. Python приписывает один текст к другому вплотную и ничего не добавляет между ними. Если между словами нужен пробел, он тоже должен лежать внутри какого-то текста.`,example:`first = "Анна"
last = "Иванова"
print(first + last)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши точно так, как будет выглядеть.`,match_mode:`code`,options:[],help_option:null,accept:[`АннаИванова`],misconceptions:[{id:`added_space`,match:[`Анна Иванова`],hint:`Знак + сам пробел не добавляет. Он склеивает тексты вплотную, а пробела в этих значениях нет.`,followup:`Есть ли пробел внутри одного из двух значений?`},{id:`printed_expression`,match:[`first + last`],hint:`print показывает результат, а не сам пример. Python сначала склеит значения.`,followup:`Какие тексты лежат в двух переменных?`}],from_example:!0,vocabulary:!1},reteach:`Представь два бумажных слова. Знак + приклеивает второе слово сразу после первого, без зазора. Зазор появится, только если он есть в самом тексте.`,walkthrough:`В first лежит Анна, в last лежит Иванова. Знак + склеивает их вплотную, пробела между ними нет. Поэтому на экране будет АннаИванова.`,alt_examples:[{code:`print("Привет, " + "мир")`,explain:`Здесь пробел лежит внутри первого текста, после запятой, поэтому в итоге слова разделены.`}],faq:[{keywords:[`пробел`],answer:`Пробел — такой же символ, как буква. Если он нужен, положи его в кавычки: " ".`}],transfer_question:{example:`a = "Привет"
b = "мир"
print(a + b)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши точно так, как будет выглядеть.`,match_mode:`code`,options:[],help_option:null,accept:[`Приветмир`],misconceptions:[{id:`added_space`,match:[`Привет мир`],hint:`Знак + сам пробел не добавляет. Тексты склеиваются вплотную.`,followup:`Есть ли пробел внутри одной из двух переменных?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P1`}},{id:`C2`,key:`fstring`,title:`f-строки`,goal:`Ученик понимает, что в f-строке значения переменных подставляются вместо {имён}.`,explain:`Склеивать много кусочков неудобно. Для этого есть f-строка: перед кавычками ставят букву f, а имена переменных пишут в фигурных скобках. Python подставит вместо каждых скобок значение.`,example:`name = "Анна"
age = 12
print(f"{name} учится, ей {age}")`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши точно так, как будет выглядеть.`,match_mode:`code`,options:[],help_option:null,accept:[`Анна учится, ей 12`],misconceptions:[{id:`braces_left`,match:[`{name} учится, ей {age}`],hint:`Фигурные скобки в f-строке — это места для значений. Python заменяет их содержимым переменных.`,followup:`Какие значения лежат в name и age?`}],from_example:!0,vocabulary:!1},reteach:`f-строка — это шаблон с «окошками». Каждое окошко в фигурных скобках Python заполняет значением переменной, а остальной текст оставляет как есть.`,walkthrough:`Python берёт шаблон и заполняет окошки: вместо {name} ставит Анна, вместо {age} ставит 12. Остальные слова остаются на месте. Получается Анна учится, ей 12.`,alt_examples:[{code:`color = "синий"
print(f"Мой любимый цвет — {color}")`,explain:`Вместо {color} Python подставит слово «синий».`}],faq:[{keywords:[`f перед`,`буква f`,`зачем f`],answer:`Буква f (от слова format) сообщает Python, что в этой строке есть места для значений.`}],transfer_question:{example:`city = "Сочи"
temp = 25
print(f"В городе {city} сейчас {temp} градусов")`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши точно так, как будет выглядеть.`,match_mode:`code`,options:[],help_option:null,accept:[`В городе Сочи сейчас 25 градусов`],misconceptions:[{id:`braces_left`,match:[`В городе {city} сейчас {temp} градусов`],hint:`Фигурные скобки Python заменяет значениями переменных.`,followup:`Какие значения лежат в city и temp?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P2`}},{id:`C3`,key:`text_methods`,title:`Методы текста`,goal:`Ученик понимает, что upper() и lower() возвращают текст с другим регистром.`,explain:`У текста есть готовые команды — методы. Их пишут через точку после значения. Метод upper() возвращает текст заглавными буквами, а lower() — строчными. Переменная при этом не меняется.`,example:`word = "робот"
print(word.upper())`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`code`,options:[`РОБОТ`,`робот`,`Робот`,`Не знаю`],help_option:`Не знаю`,accept:[`РОБОТ`],misconceptions:[{id:`unchanged`,match:[`робот`],hint:`Метод upper() как раз превращает буквы в заглавные. Именно такой текст он и возвращает.`,followup:`Какие буквы получаются после upper(): заглавные или строчные?`},{id:`first_only`,match:[`Робот`],hint:`upper() делает заглавными все буквы, а не только первую.`,followup:`Сколько букв превратится в заглавные?`}],from_example:!1,vocabulary:!1},reteach:`Метод — как кнопка на тексте. Нажал upper — получил текст большими буквами. Нажал lower — маленькими. Сам исходный текст остаётся прежним, а ты получаешь его изменённую копию.`,walkthrough:`В word лежит слово робот маленькими буквами. word.upper() берёт этот текст и возвращает его заглавными буквами. print показывает результат: РОБОТ.`,alt_examples:[{code:`shout = "ПРИВЕТ"
print(shout.lower())`,explain:`Метод lower() вернёт все буквы строчными: привет.`}],faq:[{keywords:[`скобки`,`зачем скобки`],answer:`Круглые скобки показывают, что метод нужно выполнить. Без них Python не выполнит команду.`}],transfer_question:{example:`title = "ВЕЛИКИЙ ДРАКОН"
print(title.lower())`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши точно так, как будет выглядеть.`,match_mode:`code`,options:[],help_option:null,accept:[`великий дракон`],misconceptions:[{id:`unchanged`,match:[`ВЕЛИКИЙ ДРАКОН`],hint:`Метод lower() превращает буквы в строчные, это его работа.`,followup:`Какие буквы получаются после lower()?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C4`,key:`length`,title:`Длина текста`,goal:`Ученик понимает, что len() считает все символы, включая пробелы.`,explain:`Функция len() считает, сколько символов в тексте. Пробелы и знаки препинания тоже считаются символами, как и буквы.`,example:`print(len("мама мыла"))`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`9`,`8`,`2`,`Не знаю`],help_option:`Не знаю`,accept:[`9`,`девять`],misconceptions:[{id:`space_ignored`,match:[`8`],hint:`Пробел — тоже символ. Его нужно посчитать вместе с буквами.`,followup:`Сколько в этом тексте букв и сколько пробелов?`},{id:`words_counted`,match:[`2`],hint:`len() считает не слова, а символы: каждую букву и каждый пробел.`,followup:`Сколько символов в первом слове и сколько во втором?`}],from_example:!1,vocabulary:!1},reteach:`Представь, что каждый символ — это клеточка в тетради. Буква занимает клеточку, пробел тоже занимает клеточку. len() считает все занятые клеточки.`,walkthrough:`В тексте «мама мыла» четыре буквы в первом слове, пробел и четыре буквы во втором. Всего получается 9 символов.`,alt_examples:[{code:`name = "Анна"
print(len(name))`,explain:`В имени четыре буквы, поэтому len() покажет 4.`}],faq:[],transfer_question:{example:`print(len("Привет, мир"))`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`11`,`одиннадцать`],misconceptions:[{id:`space_ignored`,match:[`10`,`десять`],hint:`Пробел и запятая — тоже символы, их нужно посчитать.`,followup:`Сколько букв, сколько знаков и сколько пробелов в тексте?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C5`,key:`index`,title:`Символ по номеру`,goal:`Ученик понимает, что нумерация символов начинается с нуля.`,explain:`Каждый символ в тексте имеет номер, и нумерация начинается с нуля: первый символ имеет номер 0, второй — номер 1 и так далее. Номер пишут в квадратных скобках сразу после текста или имени переменной.`,example:`word = "Python"
print(word[0])`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`code`,options:[`P`,`y`,`Python`,`Не знаю`],help_option:`Не знаю`,accept:[`P`],misconceptions:[{id:`counted_from_one`,match:[`y`],hint:`Нумерация начинается не с единицы, а с нуля. Номер 0 — это самый первый символ.`,followup:`Какой символ стоит самым первым?`},{id:`whole_word`,match:[`Python`],hint:`В квадратных скобках номер одного символа. Python достаёт только его.`,followup:`Сколько символов достаёт один номер?`}],from_example:!1,vocabulary:!1},reteach:`Нумерация у программистов начинается с нуля: «ноль» — это самое первое место. Поэтому номер 0 — первый символ, номер 1 — второй, номер 2 — третий.`,walkthrough:`В слове Python символы идут так: номер 0 — это P, номер 1 — это y, номер 2 — это t. В скобках стоит 0, значит, берём самый первый символ. Ответ: P.`,alt_examples:[{code:`word = "школа"
print(word[1])`,explain:`Номер 1 — это второй символ слова, поэтому на экране будет буква к.`}],faq:[{keywords:[`с нуля`,`почему ноль`,`почему 0`],answer:`Так принято у программистов: номер показывает, на сколько символов отступили от начала. У первого символа отступ нулевой.`}],transfer_question:{example:`word = "школа"
print(word[2])`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`code`,options:[],help_option:null,accept:[`о`],misconceptions:[{id:`counted_from_one`,match:[`к`],hint:`Нумерация начинается с нуля. Номер 0 — первый символ, номер 1 — второй.`,followup:`Какой символ имеет номер 0 и какой номер 1?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`independent`],after_error:[`transfer`],independent_task:`P3`}}],practice:[{id:`P1`,ladder_step:1,mode:`guided`,concepts:[`C1`],prompt:`В заготовке есть имя и фамилия. Выведи их одной строкой через пробел: Иван Петров.`,starter_code:`first = "Иван"
last = "Петров"`,expected:[],tests:[{inputs:[],output:[`Иван Петров`],call:null}],must_use:[`arith`],max_lines:3,hint:`Склей три части: first, затем пробел в кавычках, затем last. Между частями ставь знак +.`,example:`a = "до"
b = "мой"
print(a + b)`},{id:`P2`,ladder_step:2,mode:`independent`,concepts:[`C2`],prompt:`В заготовке есть имя и возраст. Выведи f-строкой фразу: Мария, 14 лет.`,starter_code:`name = "Мария"
age = 14`,expected:[],tests:[{inputs:[],output:[`Мария, 14 лет`],call:null}],must_use:[`fstring`],max_lines:3,hint:`Перед кавычками поставь f, а имена переменных запиши в фигурных скобках: f"{name}, ..."`,example:`pet = "кот"
print(f"У меня есть {pet}")`},{id:`P3`,ladder_step:3,mode:`independent`,concepts:[`C3`,`C5`],prompt:`Сохрани слово «дракон» в переменную word. Затем выведи на экран это слово заглавными буквами, а следующей строкой — его первую букву.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`ДРАКОН`,`д`],call:null}],must_use:[`methods`],max_lines:4,hint:`Первая строка — word.upper() внутри print, вторая — номер первой буквы в квадратных скобках.`,example:`w = "лес"
print(w.upper())
print(w[0])`},{id:`P4`,ladder_step:4,mode:`guided`,concepts:[`C4`],prompt:`Выведи на экран, сколько символов в тексте из заготовки.`,starter_code:`phrase = "Я учу Python"`,expected:[],tests:[{inputs:[],output:[`12`],call:null}],must_use:[`builtins`],max_lines:2,hint:`Используй len(), а внутри скобок напиши имя переменной.`,example:`w = "дом"
print(len(w))`}],project:{id:`MP3`,title:`Визитка`,intro:`Соберём программу, которая готовит текст визитки: аккуратно оформляет имя, город и считает длину имени. Будем добавлять по одной мысли.`,max_lines:10,steps:[{id:`M1`,kind:`code`,prompt:`Сохрани в переменную name имя «анна» — все буквы маленькие.`,requires:[`C1`],adds:[],tests:[{inputs:[],output:[`анна`],call:`print(name)`}],must_use:[],inputs:[],hint:`Имя — это текст, значит, нужны кавычки.`},{id:`M2`,kind:`code`,prompt:`Добавь переменную city с городом «Казань».`,requires:[`C1`],adds:[],tests:[{inputs:[],output:[`Казань`],call:`print(city)`}],must_use:[],inputs:[],hint:`Новую строку напиши под первой.`},{id:`M3`,kind:`code`,prompt:`Выведи имя с заглавной буквы. Для этого есть метод title(): он делает первую букву слова заглавной.`,requires:[`C3`],adds:[],tests:[{inputs:[],output:[`Анна`],call:null}],must_use:[`methods`],inputs:[],hint:`Напиши name.title() внутри скобок print.`},{id:`M4`,kind:`code`,prompt:`Выведи f-строкой вторую строку визитки: Анна живёт в городе Казань.`,requires:[`C2`],adds:[],tests:[{inputs:[],output:[`Анна`,`Анна живёт в городе Казань`],call:null}],must_use:[`fstring`],inputs:[],hint:`Внутри фигурных скобок можно писать и метод: {name.title()}.`},{id:`M5`,kind:`code`,prompt:`Выведи последней строкой, сколько букв в имени.`,requires:[`C4`],adds:[],tests:[{inputs:[],output:[`Анна`,`Анна живёт в городе Казань`,`4`],call:null}],must_use:[`builtins`],inputs:[],hint:`len(name) внутри print.`},{id:`M6`,kind:`predict_output`,prompt:`Посмотри на программу и напиши, что она покажет на экране. Каждое значение — с новой строки.`,requires:[`C3`],adds:[],tests:[],must_use:[],inputs:[],hint:`Идём сверху вниз. Не забудь, что title() меняет только то, что выводится.`}],outro:`Готово: визитка собрана из переменных, f-строки и методов. Именно так программы формируют красивый текст из данных.`},assignment:{id:`T3`,title:`Бейдж участника конференции`,level:`Лёгкое`,summary:`Оформляет данные участника для бейджа: имя, компания, длина имени и первая буква.`,brief:`Заказчик: организаторы IT-конференции. Нужно подготовить текст для бейджа участника из сырых данных, которые ввели с маленькой буквы.

Исходные данные: имя «анна петрова» и компания «dragon dev studio».

Ожидаемый вывод:
АННА ПЕТРОВА
Компания: Dragon Dev Studio
Символов в имени: 12
Первая буква: А`,requirements:[`Имя выведи заглавными буквами`,`Название компании выведи с заглавной буквы каждого слова (метод title)`,`Посчитай длину имени функцией len, пробел тоже символ`,`Первую букву имени выведи заглавной`,`Для строк со значениями используй f-строки`],plan:[`Запиши name и company как две переменные с текстом.`,`Заглавные буквы даёт name.upper(), каждое слово с большой буквы даёт company.title().`,`Длину текста считает len(name), первую букву даёт name[0].`,`Строки со значениями собирай f-строкой.`],warmup:{prompt:`Запиши имя маленькими буквами: name = "олег". Выведи это имя так, чтобы оно началось с большой буквы: Олег.`,tests:[{inputs:[],output:[`Олег`],call:null}],must_use:[`methods`],max_lines:3,hint:`У текста есть метод title(): print(name.title()).`},tests:[{inputs:[],output:[`АННА ПЕТРОВА`,`Компания: Dragon Dev Studio`,`Символов в имени: 12`,`Первая буква: А`],call:null}],must_use:[`fstring`,`methods`,`builtins`,`index`],max_lines:8,hint:`name.upper() даёт заглавные буквы, company.title() — Каждое Слово С Заглавной, name[0] — первая буква.`},code_feedback:{syntax_error:`Python не смог прочитать эту строку. Чаще всего не хватает кавычки или скобки — проверь, что у каждой открывающей есть закрывающая.`,too_many_lines:`Здесь нужно меньше строк. Оставь только то, о чём просит задание.`,not_learned_yet:`В коде есть то, что мы ещё не проходили. Попробуй решить задание тем, что уже знаешь.`,missing_assignment:`Не вижу строки, где значение сохраняется в нужную переменную.`,wrong_variable_name:`Имя переменной отличается от того, что в задании. Проверь, как оно пишется.`,missing_quotes:`Без кавычек Python считает слово именем другой переменной и ищет её. Текст нужно взять в кавычки.`,empty_text:`Между кавычками пусто. Напиши текст внутри них.`,string_instead_of_number:`Число в кавычках Python считает текстом. Здесь нужно именно число, поэтому кавычки не нужны.`,number_instead_of_string:`Здесь нужен текст, поэтому значение пишется в кавычках.`,number_out_of_range:`Число выглядит необычно для этого задания. Проверь его ещё раз.`,missing_print:`Значение сохранено, но на экран оно не выводится. Для этого нужен print.`,printed_literal_instead_of_variable:`В скобках print стоит текст в кавычках, поэтому на экран выведется само это слово. Чтобы вывести значение переменной, напиши её имя без кавычек.`,unchanged_starter:`Строка пока осталась такой же, как была. Измени её по заданию.`,wrong_output:`Программа работает, но результат не тот, что нужен. Сравни, что ожидалось и что получилось.`,runtime_error:`Программа остановилась с ошибкой. Прочитай, что случилось, и исправь это место.`,too_slow:`Программа не закончила работу. Скорее всего, цикл никогда не останавливается.`,missing_construct:`Задание нужно решить с помощью темы урока. Посмотри, что именно требуется.`,empty_code:`Поле пустое. Напиши программу по заданию и нажми «Проверить».`}},{id:`L4`,version:1,title:`Ввод данных`,welcome:`Урок 4. Пока наши программы знали только то, что мы сами записали в код. Теперь научим их спрашивать человека и работать с его ответами. Так работают настоящие программы: калькуляторы, анкеты, игры.`,features:[`input`,`convert`],phrases:{greeting:`Привет! Я твой преподаватель программирования. Учиться будем маленькими шагами: я объясняю одну мысль, показываю короткий пример и задаю один вопрос. Если что-то непонятно — просто напиши об этом, это нормальная часть обучения.`,correct:[`Верно.`,`Да, правильно.`,`Точно.`],correct_after_help:`Верно. Закрепим на новом примере.`,clarify:`Я не совсем понял сообщение. Это ответ на вопрос или мне объяснить по-другому?`,off_topic:`Давай вернёмся к уроку — так ты быстрее дойдёшь до своей первой программы.`,return_to_question:`Вернёмся к вопросу:`,not_learned_yet:`Хороший вопрос, но для этого нужны темы, которых мы ещё не проходили. Мы дойдём до них в следующих уроках.`,dont_know:`Ничего страшного, разберём вместе.`,assessment_help:`Это проверочный вопрос, поэтому ответ я не подскажу. Напомню главное:`,why_fallback:`Хороший вопрос. Чтобы не сбиться, давай сначала закончим этот шаг, а потом вернёмся к нему.`,practice_intro:`Теперь попробуй написать код сам. Пиши прямо в поле в сообщении. Кнопка «Запустить» покажет, что выведет программа, а «Проверить» отправит решение на проверку.`,practice_correct:`Код правильный.`,project_paused:`Для этого шага пригодится тема, которую стоит повторить. Повторим её и сразу вернёмся к проекту.`,project_resumed:`Возвращаемся к проекту.`,concept_mastered:`Тема освоена:`,lesson_complete:`Урок пройден. Теперь твои программы умеют общаться с человеком.`,how_to_use:`Как это работает. Я объясняю, а ты отвечаешь: нажимай на кнопки с ответами или пиши своими словами в строке внизу. Если что-то непонятно, нажми «Объясни проще», и я объясню по-другому. Ошибаться можно, так и учатся.`,transfer_intro:`Теперь тот же вопрос на новом примере.`,try_again:`Попробуй ещё раз.`,concepts_done:`Все темы урока разобраны. Теперь потренируемся писать код самому.`,practice_retry:`Исправь код и отправь снова.`,hint_no_open:`Сейчас у меня нет открытого вопроса. Можно задать вопрос по теме или нажать «Повтори».`,next_lessons:`Этот урок уже пройден. Любой урок можно повторить: открой «Мой путь» на главном экране.`,review_intro:`Вернёмся к теме «{title}». Сначала напомню главное.`,predict_reveal:`Вот что будет на экране:`,reteach_intro:`Объясню по-другому.`,assignment_intro:`Это тестовое задание. Прочитай условие и требования, а план решения подскажет, с чего начать. Принятое решение попадёт в твоё портфолио.`,warmup_intro:`Впереди тестовое задание, как на собеседовании или от заказчика. Сначала разминка: маленькая задача на ту же тему, чтобы войти в ритм. Подсказка доступна всегда.`,warmup_done:`Разминка пройдена. Теперь само задание.`},concepts:[{id:`C1`,key:`input_basics`,title:`Команда input()`,goal:`Ученик понимает, что input() возвращает то, что напечатал человек.`,explain:`Программа может спросить что-то у человека. Команда input() ждёт, пока человек напечатает текст и нажмёт Enter, и возвращает этот текст. Его сохраняют в переменную. В скобках можно написать вопрос, который человек увидит на экране.`,example:`name = input("Как тебя зовут? ")
print(f"Привет, {name}!")`,question:{kind:`gating`,format:`input`,meaning:`Допустим, человек ввёл имя Олег. Что программа выведет через print? Напиши точно так, как будет выглядеть.`,match_mode:`code`,options:[],help_option:null,accept:[`Привет, Олег!`],misconceptions:[{id:`variable_name_printed`,match:[`Привет, name!`],hint:`В f-строке имя в фигурных скобках заменяется значением переменной. В переменной лежит то, что ввёл человек.`,followup:`Что лежит в переменной name после того, как человек ввёл имя?`},{id:`braces_left`,match:[`Привет, {name}!`],hint:`Фигурные скобки Python заменяет значением переменной.`,followup:`Что именно ввёл человек?`}],from_example:!1,vocabulary:!1},reteach:`input() работает как вопрос на анкете: программа спрашивает, человек пишет ответ, и этот ответ попадает в переменную. Дальше с ним работают так же, как с любым другим значением.`,walkthrough:`Строка с input() ждёт ответ. Человек вводит Олег, и это слово сохраняется в переменную name. Затем f-строка подставляет его на место {name}. На экране будет: Привет, Олег!`,alt_examples:[{code:`color = input("Любимый цвет? ")
print(f"Твой цвет — {color}")`,explain:`Что человек введёт в ответ, то и попадёт в color, а потом на экран.`}],faq:[{keywords:[`enter`,`энтер`],answer:`Клавиша Enter завершает ввод: после неё программа получает напечатанный текст и идёт дальше.`}],transfer_question:{example:`city = input("Из какого ты города? ")
print(f"Ты из города {city}")`,question:{kind:`gating`,format:`input`,meaning:`Допустим, человек ввёл Сочи. Что программа выведет через print? Напиши точно так, как будет выглядеть.`,match_mode:`code`,options:[],help_option:null,accept:[`Ты из города Сочи`],misconceptions:[{id:`variable_name_printed`,match:[`Ты из города city`],hint:`Вместо {city} Python подставит то, что ввёл человек.`,followup:`Что лежит в переменной city после ввода?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P1`}},{id:`C2`,key:`input_is_text`,title:`Ввод — всегда текст`,goal:`Ученик понимает, что input() возвращает текст даже из цифр, а + склеивает тексты.`,explain:`Что бы человек ни ввёл, input() возвращает текст. Даже если человек напечатал цифры, Python получает текст из цифр, а не число. Поэтому знак + склеивает такие значения, как любые другие тексты.`,example:`a = input()
b = input()
print(a + b)`,question:{kind:`gating`,format:`choice`,meaning:`Допустим, человек ввёл сначала 3, потом 4. Что появится на экране?`,match_mode:`text`,options:[`7`,`34`,`Не знаю`],help_option:`Не знаю`,accept:[`34`],misconceptions:[{id:`added_as_numbers`,match:[`7`],hint:`input() возвращает текст, даже если в нём цифры. А знак + склеивает тексты вплотную.`,followup:`Что делает знак + с двумя текстами?`}],from_example:!1,vocabulary:!1},reteach:`Для input() всё, что напечатал человек, — просто символы, как буквы. Цифра 3 в таком тексте ничем не отличается от буквы. А тексты знак + склеивает, а не складывает.`,walkthrough:`В a лежит текст «3», в b лежит текст «4». Это тексты, а не числа. Знак + склеивает их вплотную, получается 34.`,alt_examples:[{code:`x = input()
print(x + x)`,explain:`Если человек введёт 5, то x + x склеит два текста «5», и получится 55.`}],faq:[{keywords:[`почему текст`,`зачем текст`],answer:`Человек может ввести что угодно: слово, число, смайлик. Поэтому input() безопасно возвращает всё как текст, а превращать его в число можно отдельно.`}],transfer_question:{example:`x = input()
y = input()
print(x + y)`,question:{kind:`gating`,format:`input`,meaning:`Допустим, человек ввёл сначала 10, потом 5. Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`105`],misconceptions:[{id:`added_as_numbers`,match:[`15`,`пятнадцать`],hint:`Введённое — это тексты, а знак + склеивает тексты, а не складывает числа.`,followup:`Как выглядит склейка текстов «10» и «5»?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C3`,key:`int_conversion`,title:`int(): текст в число`,goal:`Ученик понимает, что int(input()) даёт число, с которым можно считать.`,explain:`Чтобы считать с введённым числом, текст из цифр превращают в число функцией int(). Её оборачивают вокруг input(): внутри сначала читается текст, а снаружи он превращается в целое число.`,example:`a = int(input())
b = int(input())
print(a + b)`,question:{kind:`gating`,format:`input`,meaning:`Допустим, человек ввёл сначала 3, потом 4. Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`7`,`семь`],misconceptions:[{id:`glued_text`,match:[`34`],hint:`Здесь значения уже превращены в числа функцией int(). Числа знак + складывает.`,followup:`Чему равна сумма чисел, которые ввёл человек?`}],from_example:!1,vocabulary:!1},reteach:`int() — это переводчик с языка текста на язык чисел. После перевода Python знает, что «3» — это число, и может с ним считать.`,walkthrough:`int(input()) читает текст «3» и превращает его в число 3. То же происходит со вторым значением: оно становится числом 4. Числа знак + складывает, получается 7.`,alt_examples:[{code:`age = int(input())
print(age + 1)`,explain:`Если человек введёт 12, int() сделает из текста число, и print покажет 13.`}],faq:[{keywords:[`ошибк`,`не число`,`букв`],answer:`Если человек введёт не число, например слово, int() остановит программу с ошибкой. Позже научимся такие случаи проверять.`}],transfer_question:{example:`x = int(input())
y = int(input())
print(x * y)`,question:{kind:`gating`,format:`input`,meaning:`Допустим, человек ввёл сначала 10, потом 5. Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`50`,`пятьдесят`],misconceptions:[{id:`glued_text`,match:[`105`],hint:`Здесь введённое превращено в числа функцией int(), а знак * умножает числа.`,followup:`Чему равно произведение двух чисел?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P2`}},{id:`C4`,key:`float_conversion`,title:`float(): числа с точкой`,goal:`Ученик понимает, что для дробных чисел нужна float(), а int() для них даст ошибку.`,explain:`Если человек может ввести число с точкой, например 2.5, используй функцию float(). Функция int() такой текст не примет и остановит программу с ошибкой. А результат вычислений с float тоже получается числом с точкой.`,example:`price = float(input())
print(price * 2)`,question:{kind:`gating`,format:`input`,meaning:`Допустим, человек ввёл 2.5. Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`5.0`,`5,0`],misconceptions:[{id:`dropped_fraction`,match:[`5`],hint:`Число с точкой остаётся числом с точкой, даже если после точки ноль.`,followup:`Как выглядит результат вычислений с числом, у которого есть точка?`},{id:`glued_text`,match:[`2.52.5`],hint:`Значение превращено в число функцией float(), а не осталось текстом. Число знак * умножает.`,followup:`Чему равно число 2.5, умноженное на два?`}],from_example:!1,vocabulary:!1},reteach:`float() работает так же, как int(), только понимает числа с точкой. Если в вычислении участвует такое число, результат тоже будет с точкой.`,walkthrough:`float(input()) превращает текст «2.5» в число 2.5. Умножаем на 2 и получаем 5.0. Ответ записывается с точкой, потому что число было дробным.`,alt_examples:[{code:`x = float(input())
print(x + 1)`,explain:`Если человек введёт 0.5, то на экране будет 1.5.`}],faq:[{keywords:[`запят`,`через запят`],answer:`В Python дробную часть отделяют точкой, а не запятой: 2.5, а не 2,5.`}],transfer_question:{example:`x = float(input())
print(x + 2)`,question:{kind:`gating`,format:`input`,meaning:`Допустим, человек ввёл 1.5. Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`3.5`,`3,5`],misconceptions:[{id:`dropped_fraction`,match:[`3`],hint:`Число с точкой не теряет дробную часть, когда к нему прибавляют целое.`,followup:`Чему равно число 1.5, увеличенное на два?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P4`}}],practice:[{id:`P1`,ladder_step:1,mode:`guided`,concepts:[`C1`],prompt:`Спроси у человека его имя командой input() и поприветствуй его: Привет, Анна! (если ввели Анна).`,starter_code:null,expected:[],tests:[{inputs:[`Анна`],output:[`Привет, Анна!`],call:null},{inputs:[`Олег`],output:[`Привет, Олег!`],call:null}],must_use:[`input`],max_lines:3,hint:`Сохрани результат input() в переменную, а затем выведи её через f-строку или склейку.`,example:`pet = input("Кто у тебя дома? ")
print(f"Ага, у тебя {pet}")`},{id:`P2`,ladder_step:2,mode:`guided`,concepts:[`C2`,`C3`],prompt:`Программа читает два целых числа (каждое вводится отдельно) и выводит их сумму.`,starter_code:null,expected:[],tests:[{inputs:[`3`,`4`],output:[`7`],call:null},{inputs:[`10`,`25`],output:[`35`],call:null}],must_use:[`convert`],max_lines:4,hint:`Оберни каждый input() в int(), иначе числа склеятся как тексты.`,example:`x = int(input())
y = int(input())
print(x * y)`},{id:`P3`,ladder_step:3,mode:`independent`,concepts:[`C3`],prompt:`Прочитай возраст (целое число) и выведи, сколько лет человеку будет через 10 лет.`,starter_code:null,expected:[],tests:[{inputs:[`12`],output:[`22`],call:null},{inputs:[`35`],output:[`45`],call:null}],must_use:[`convert`],max_lines:3,hint:`Возраст нужно превратить в число функцией int(), а потом прибавить 10.`,example:`n = int(input())
print(n * 2)`},{id:`P4`,ladder_step:4,mode:`guided`,concepts:[`C4`],prompt:`Яблоки стоят дороже, если брать их на вес. Прочитай цену за килограмм (она может быть с точкой) и выведи стоимость трёх килограммов.`,starter_code:null,expected:[],tests:[{inputs:[`2.5`],output:[`7.5`],call:null},{inputs:[`1.5`],output:[`4.5`],call:null},{inputs:[`10`],output:[`30.0`],call:null}],must_use:[`convert`],max_lines:3,hint:`Для чисел с точкой нужна float(), а не int().`,example:`p = float(input())
print(p + 0.5)`},{id:`P5`,ladder_step:5,mode:`independent`,concepts:[`C1`,`C3`],prompt:`Спроси имя, потом возраст. Выведи одну строку в таком виде: Анна, через 10 лет тебе будет 22 (если ввели Анна и 12).`,starter_code:null,expected:[],tests:[{inputs:[`Анна`,`12`],output:[`Анна, через 10 лет тебе будет 22`],call:null},{inputs:[`Олег`,`30`],output:[`Олег, через 10 лет тебе будет 40`],call:null}],must_use:[`input`,`convert`],max_lines:4,hint:`В фигурных скобках f-строки можно писать вычисление, например {age + 10}.`,example:null}],project:{id:`MP4`,title:`Анкета путешественника`,intro:`Соберём анкету: программа спросит имя, возраст и рост, а потом выведет всё одной красивой фразой и посчитает возраст через несколько лет.`,max_lines:12,steps:[{id:`M1`,kind:`code`,prompt:`Спроси имя и сохрани его в переменную name.`,requires:[`C1`],adds:[],tests:[{inputs:[`Анна`],output:[`Анна`],call:`print(name)`}],must_use:[`input`],inputs:[],hint:`name = input(...), в скобках можно написать вопрос.`},{id:`M2`,kind:`code`,prompt:`Спроси возраст и сохрани его числом в переменную age.`,requires:[`C3`],adds:[],tests:[{inputs:[`Анна`,`12`],output:[`13`],call:`print(age + 1)`}],must_use:[`convert`],inputs:[],hint:`Оберни input() в int(), чтобы получить число.`},{id:`M3`,kind:`code`,prompt:`Спроси рост в метрах (например, 1.5) и сохрани числом в переменную height.`,requires:[`C4`],adds:[],tests:[{inputs:[`Анна`,`12`,`1.5`],output:[`3.0`],call:`print(height * 2)`}],must_use:[],inputs:[],hint:`Рост может быть с точкой, значит, нужна float().`},{id:`M4`,kind:`code`,prompt:`Выведи одну строку в таком виде: Анна, тебе 12 лет, рост 1.5 м.`,requires:[`C1`],adds:[],tests:[{inputs:[`Анна`,`12`,`1.5`],output:[`Анна, тебе 12 лет, рост 1.5 м`],call:null},{inputs:[`Олег`,`30`,`1.8`],output:[`Олег, тебе 30 лет, рост 1.8 м`],call:null}],must_use:[`fstring`],inputs:[],hint:`Используй f-строку: f"{name}, тебе {age} лет, ..."`},{id:`M5`,kind:`code`,prompt:`Добавь вторую строку: Через 5 лет тебе будет 17 (прибавь 5 к возрасту).`,requires:[`C3`],adds:[],tests:[{inputs:[`Анна`,`12`,`1.5`],output:[`Анна, тебе 12 лет, рост 1.5 м`,`Через 5 лет тебе будет 17`],call:null},{inputs:[`Олег`,`30`,`1.8`],output:[`Олег, тебе 30 лет, рост 1.8 м`,`Через 5 лет тебе будет 35`],call:null}],must_use:[],inputs:[],hint:`В фигурных скобках можно писать вычисление: {age + 5}.`},{id:`M6`,kind:`predict_output`,prompt:`Допустим, пользователь ввёл Олег, 20 и 1.8. Напиши, что программа покажет на экране. Каждая строка — с новой строки.`,requires:[`C3`],adds:[],tests:[],must_use:[],inputs:[`Олег`,`20`,`1.8`],hint:`Подставь введённые значения в обе f-строки и посчитай возраст через 5 лет.`}],outro:`Готово: программа сама задаёт вопросы, превращает ответы в числа и собирает из них фразу. С этого начинаются настоящие приложения.`},assignment:{id:`T4`,title:`Калькулятор индекса массы тела`,level:`Среднее`,summary:`Спрашивает имя, вес и рост и считает индекс массы тела (ИМТ) с округлением.`,brief:`Заказчик: фитнес-приложение. Нужен калькулятор ИМТ. Программа спрашивает имя, вес в килограммах и рост в метрах (оба числа могут быть дробными), а потом выводит результат.

Формула: ИМТ = вес, делённый на рост в квадрате (рост ** 2). Результат округли до одного знака после точки функцией round(число, 1).

Пример. Ввод: Анна, 70, 1.75. Вывод:
Анна, ваш ИМТ: 22.9`,requirements:[`Три отдельных ввода в таком порядке: имя, вес, рост`,`Вес и рост могут быть дробными числами`,`Округли ИМТ до одного знака функцией round`,`Выведи одну строку строго в формате: Имя, ваш ИМТ: число`],plan:[`Прочитай имя, вес и рост тремя вызовами input.`,`Вес и рост переводи в числа функцией float.`,`Посчитай weight / height ** 2.`,`Выведи результат, округлив round(значение, 1), в формате из условия.`],warmup:{prompt:`Спроси у пользователя имя (input) и выведи приветствие в формате: Привет, Анна! (вместо Анны подставь введённое имя).`,tests:[{inputs:[`Анна`],output:[`Привет, Анна!`],call:null},{inputs:[`Олег`],output:[`Привет, Олег!`],call:null}],must_use:[`input`],max_lines:4,hint:`name = input("...") и потом f-строка: print(f"Привет, {name}!").`},tests:[{inputs:[`Анна`,`70`,`1.75`],output:[`Анна, ваш ИМТ: 22.9`],call:null},{inputs:[`Олег`,`90`,`1.8`],output:[`Олег, ваш ИМТ: 27.8`],call:null},{inputs:[`Мария`,`50`,`1.6`],output:[`Мария, ваш ИМТ: 19.5`],call:null},{inputs:[`Иван`,`82.5`,`1.9`],output:[`Иван, ваш ИМТ: 22.9`],call:null}],must_use:[`input`,`convert`,`fstring`],max_lines:8,hint:`float(input()) для веса и роста, формула weight / height ** 2, потом round(..., 1) внутри f-строки.`},code_feedback:{syntax_error:`Python не смог прочитать эту строку. Чаще всего не хватает кавычки или скобки — проверь, что у каждой открывающей есть закрывающая.`,too_many_lines:`Здесь нужно меньше строк. Оставь только то, о чём просит задание.`,not_learned_yet:`В коде есть то, что мы ещё не проходили. Попробуй решить задание тем, что уже знаешь.`,missing_assignment:`Не вижу строки, где значение сохраняется в нужную переменную.`,wrong_variable_name:`Имя переменной отличается от того, что в задании. Проверь, как оно пишется.`,missing_quotes:`Без кавычек Python считает слово именем другой переменной и ищет её. Текст нужно взять в кавычки.`,empty_text:`Между кавычками пусто. Напиши текст внутри них.`,string_instead_of_number:`Число в кавычках Python считает текстом. Здесь нужно именно число, поэтому кавычки не нужны.`,number_instead_of_string:`Здесь нужен текст, поэтому значение пишется в кавычках.`,number_out_of_range:`Число выглядит необычно для этого задания. Проверь его ещё раз.`,missing_print:`Значение сохранено, но на экран оно не выводится. Для этого нужен print.`,printed_literal_instead_of_variable:`В скобках print стоит текст в кавычках, поэтому на экран выведется само это слово. Чтобы вывести значение переменной, напиши её имя без кавычек.`,unchanged_starter:`Строка пока осталась такой же, как была. Измени её по заданию.`,wrong_output:`Программа работает, но результат не тот, что нужен. Сравни, что ожидалось и что получилось.`,runtime_error:`Программа остановилась с ошибкой. Прочитай, что случилось, и исправь это место.`,too_slow:`Программа не закончила работу. Скорее всего, цикл никогда не останавливается.`,missing_construct:`Задание нужно решить с помощью темы урока. Посмотри, что именно требуется.`,empty_code:`Поле пустое. Напиши программу по заданию и нажми «Проверить».`}},{id:`L5`,version:1,title:`Условия`,welcome:`Урок 5. Сейчас наши программы выполняют все строки подряд. Научим их принимать решения: делать одно, если условие верно, и другое, если нет. Это один из самых важных приёмов в программировании.`,features:[`compare`,`bool`,`if`,`logic`],phrases:{greeting:`Привет! Я твой преподаватель программирования. Учиться будем маленькими шагами: я объясняю одну мысль, показываю короткий пример и задаю один вопрос. Если что-то непонятно — просто напиши об этом, это нормальная часть обучения.`,correct:[`Верно.`,`Да, правильно.`,`Точно.`],correct_after_help:`Верно. Закрепим на новом примере.`,clarify:`Я не совсем понял сообщение. Это ответ на вопрос или мне объяснить по-другому?`,off_topic:`Давай вернёмся к уроку — так ты быстрее дойдёшь до своей первой программы.`,return_to_question:`Вернёмся к вопросу:`,not_learned_yet:`Хороший вопрос, но для этого нужны темы, которых мы ещё не проходили. Мы дойдём до них в следующих уроках.`,dont_know:`Ничего страшного, разберём вместе.`,assessment_help:`Это проверочный вопрос, поэтому ответ я не подскажу. Напомню главное:`,why_fallback:`Хороший вопрос. Чтобы не сбиться, давай сначала закончим этот шаг, а потом вернёмся к нему.`,practice_intro:`Теперь попробуй написать код сам. Пиши прямо в поле в сообщении. Кнопка «Запустить» покажет, что выведет программа, а «Проверить» отправит решение на проверку.`,practice_correct:`Код правильный.`,project_paused:`Для этого шага пригодится тема, которую стоит повторить. Повторим её и сразу вернёмся к проекту.`,project_resumed:`Возвращаемся к проекту.`,concept_mastered:`Тема освоена:`,lesson_complete:`Урок пройден. Теперь программы умеют выбирать, что делать.`,how_to_use:`Как это работает. Я объясняю, а ты отвечаешь: нажимай на кнопки с ответами или пиши своими словами в строке внизу. Если что-то непонятно, нажми «Объясни проще», и я объясню по-другому. Ошибаться можно, так и учатся.`,transfer_intro:`Теперь тот же вопрос на новом примере.`,try_again:`Попробуй ещё раз.`,concepts_done:`Все темы урока разобраны. Теперь потренируемся писать код самому.`,practice_retry:`Исправь код и отправь снова.`,hint_no_open:`Сейчас у меня нет открытого вопроса. Можно задать вопрос по теме или нажать «Повтори».`,next_lessons:`Этот урок уже пройден. Любой урок можно повторить: открой «Мой путь» на главном экране.`,review_intro:`Вернёмся к теме «{title}». Сначала напомню главное.`,predict_reveal:`Вот что будет на экране:`,reteach_intro:`Объясню по-другому.`,assignment_intro:`Это тестовое задание. Прочитай условие и требования, а план решения подскажет, с чего начать. Принятое решение попадёт в твоё портфолио.`,warmup_intro:`Впереди тестовое задание, как на собеседовании или от заказчика. Сначала разминка: маленькая задача на ту же тему, чтобы войти в ритм. Подсказка доступна всегда.`,warmup_done:`Разминка пройдена. Теперь само задание.`},concepts:[{id:`C1`,key:`comparison`,title:`Сравнения: True и False`,goal:`Ученик понимает, что сравнение даёт True или False.`,explain:`Чтобы принять решение, значения сравнивают: > значит «больше», < значит «меньше», >= значит «больше или равно», == значит «равно», != значит «не равно». Результат сравнения — особое значение: True («да») или False («нет»).`,example:`age = 15
print(age > 18)`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`True`,`False`,`15`,`Не знаю`],help_option:`Не знаю`,accept:[`False`],misconceptions:[{id:`wrong_direction`,match:[`True`],hint:`Проверь сравнение само по себе: подставь вместо age число 15 и спроси себя, правда ли, что оно больше второго числа.`,followup:`Правда ли, что 15 больше 18?`},{id:`value_printed`,match:[`15`],hint:`print показывает не само число, а ответ на вопрос «больше ли оно?». Ответ — True или False.`,followup:`Что отвечает Python: да или нет?`}],from_example:!1,vocabulary:!0},reteach:`Сравнение — это вопрос к Python. Он отвечает только «да» (True) или «нет» (False). print показывает этот ответ.`,walkthrough:`Python берёт age, это 15, и спрашивает: 15 больше 18? Нет. Значит, ответ False, его и покажет print.`,alt_examples:[{code:`price = 300
print(price == 300)`,explain:`Спрашиваем «price равно 300?». Это правда, поэтому на экране True.`}],faq:[{keywords:[`два равно`,`== `,`двойное`,`два знака`],answer:`Один знак = сохраняет значение в переменную. Два знака == сравнивают. Их легко перепутать, поэтому запомни: сравнение — это вопрос, и в нём два знака.`}],transfer_question:{example:`temp = 25
print(temp < 30)`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`True`,`False`,`Не знаю`],help_option:`Не знаю`,accept:[`True`],misconceptions:[{id:`wrong_direction`,match:[`False`],hint:`Подставь вместо temp число 25 и проверь: правда ли, что оно меньше второго числа?`,followup:`Правда ли, что 25 меньше 30?`}],from_example:!1,vocabulary:!0}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C2`,key:`text_comparison`,title:`Сравнение текстов`,goal:`Ученик понимает, что тексты сравниваются точно, включая регистр.`,explain:`Сравнивать можно и тексты. Python сравнивает их буква за буквой и очень строго: заглавная и строчная буквы — это разные символы.`,example:`print("Python" == "python")`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`True`,`False`,`Не знаю`],help_option:`Не знаю`,accept:[`False`],misconceptions:[{id:`case_ignored`,match:[`True`],hint:`Для Python заглавная и строчная буквы — разные символы. Сравни первые буквы.`,followup:`Одинаковы ли первые буквы в двух текстах?`}],from_example:!1,vocabulary:!0},reteach:`Представь проверку пароля: слово «Дом» и слово «дом» не совпадают, потому что первая буква разная. Python проверяет так же строго.`,walkthrough:`В первом тексте первая буква P заглавная, во втором p строчная. Это разные символы, поэтому тексты не равны. Ответ: False.`,alt_examples:[{code:`print("кот" == "кот")`,explain:`Тексты совпадают буква в букву, поэтому на экране True.`}],faq:[{keywords:[`регистр`],answer:`Регистр — это заглавные и строчные буквы. Чтобы сравнивать без учёта регистра, можно привести оба текста к одному виду, например методом lower().`}],transfer_question:{example:`print("Да" != "да")`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`True`,`False`,`Не знаю`],help_option:`Не знаю`,accept:[`True`],misconceptions:[{id:`case_ignored`,match:[`False`],hint:`Знак != спрашивает «не равны ли?». Для Python эти тексты разные, потому что регистр разный.`,followup:`Равны ли эти тексты?`}],from_example:!1,vocabulary:!0}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C3`,key:`if_statement`,title:`Условие if`,goal:`Ученик понимает, что строки с отступом после if выполняются только при верном условии.`,explain:`Условие if выполняет код только тогда, когда сравнение даёт True. После условия ставят двоеточие, а код, который нужно выполнить, пишут ниже с отступом из четырёх пробелов. Отступ показывает Python, что строка принадлежит условию. Строки без отступа выполняются всегда.`,example:`age = 12
if age >= 18:
    print("Взрослый")
print("Привет")`,question:{kind:`gating`,format:`choice`,meaning:`Сколько строк появится на экране?`,match_mode:`text`,options:[`0`,`1`,`2`,`Не знаю`],help_option:`Не знаю`,accept:[`1`],misconceptions:[{id:`all_lines`,match:[`2`],hint:`Строка с отступом выполняется только при верном условии. Проверь: условие верно?`,followup:`Верно ли, что 12 больше или равно второму числу?`},{id:`nothing_printed`,match:[`0`],hint:`Последняя строка стоит без отступа, значит, она не зависит от условия и выполняется всегда.`,followup:`Какая из двух строк print стоит без отступа?`}],from_example:!1,vocabulary:!1},reteach:`if — это развилка. Если условие верно, Python заходит в «комнату» с отступом и выполняет её строки. Если нет, комнату пропускает и идёт дальше, к строкам без отступа.`,walkthrough:`12 >= 18 — неверно, значит, строка с отступом пропускается. Последняя строка стоит без отступа и выполняется всегда. На экране одна строка: Привет.`,alt_examples:[{code:`n = 20
if n > 10:
    print("Много")
print("Всё")`,explain:`Условие верно, поэтому выполнятся обе строки: Много и Всё.`}],faq:[{keywords:[`отступ`,`пробел`],answer:`Отступ — четыре пробела в начале строки. В поле для кода его можно поставить клавишей Tab или четырьмя пробелами.`},{keywords:[`двоеточ`],answer:`Двоеточие в конце строки с if говорит Python: «дальше идёт блок кода, который выполняется при этом условии».`}],transfer_question:{example:`score = 8
if score > 5:
    print("Победа")
    print("Награда")
print("Игра окончена")`,question:{kind:`gating`,format:`input`,meaning:`Сколько строк появится на экране? Ответь числом.`,match_mode:`text`,options:[],help_option:null,accept:[`3`,`три`],misconceptions:[{id:`block_skipped`,match:[`1`,`одна`],hint:`Проверь условие: оно верно, поэтому обе строки с отступом тоже выполняются.`,followup:`Верно ли, что 8 больше 5?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`independent`],after_error:[`transfer`],independent_task:`P1`}},{id:`C4`,key:`else_elif`,title:`else и elif`,goal:`Ученик понимает, что else выполняется, когда условие неверно, а elif добавляет ещё вариант.`,explain:`Если условие неверно, можно выбрать другой путь словом else, то есть «иначе». Оно тоже заканчивается двоеточием, а действие пишется с отступом. Если вариантов больше двух, между if и else добавляют elif — ещё одно условие. Python проверяет их сверху вниз и выполняет только первый подошедший вариант.`,example:`age = 12
if age >= 18:
    print("Взрослый")
else:
    print("Ребёнок")`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`Ребёнок`],misconceptions:[{id:`wrong_branch`,match:[`Взрослый`],hint:`Сначала проверь условие после if. Если оно неверно, выполняется ветка else.`,followup:`Верно ли, что 12 больше или равно второму числу?`}],from_example:!1,vocabulary:!1},reteach:`Это развилка с двумя дорогами. Условие верно — идём по первой. Неверно — по второй, после else. Идти по обеим сразу нельзя.`,walkthrough:`Проверяем 12 >= 18: нет. Значит, ветка if пропускается, и Python выполняет ветку else. На экране: Ребёнок.`,alt_examples:[{code:`n = 5
if n % 2 == 0:
    print("чётное")
else:
    print("нечётное")`,explain:`Остаток от деления на два равен единице, поэтому условие неверно. Сработает else.`}],faq:[{keywords:[`elif`],answer:`elif — сокращение от «else if», то есть «а если ещё так». Он нужен, чтобы проверить ещё одно условие, если предыдущие не подошли.`}],transfer_question:{example:`n = 0
if n > 0:
    print("плюс")
elif n < 0:
    print("минус")
else:
    print("ноль")`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`ноль`],misconceptions:[{id:`wrong_branch`,match:[`плюс`,`минус`],hint:`Проверяй условия сверху вниз: первое неверно, второе тоже. Что остаётся?`,followup:`Какая ветка выполняется, если ни одно условие не подошло?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P3`}},{id:`C5`,key:`logic_operators`,title:`and, or, not`,goal:`Ученик понимает: and требует оба условия, or — хотя бы одно, not переворачивает ответ.`,explain:`Условия можно соединять. Слово and значит «и»: должны выполниться оба условия. Слово or значит «или»: достаточно одного. Слово not переворачивает ответ: было True, станет False.`,example:`x = 5
print(x > 1 and x < 3)
print(x > 1 or x < 3)`,question:{kind:`gating`,format:`choice`,meaning:`Что покажет вторая строка, с or?`,match_mode:`text`,options:[`True`,`False`,`Не знаю`],help_option:`Не знаю`,accept:[`True`],misconceptions:[{id:`or_as_and`,match:[`False`],hint:`or требует, чтобы выполнилось хотя бы одно из двух условий. Проверь каждое отдельно.`,followup:`Верно ли хотя бы одно из условий: x больше первого числа или x меньше второго?`}],from_example:!1,vocabulary:!0},reteach:`and — строгий охранник: пропускает, только если выполнены оба условия. or — добрый: пропускает, если выполнено хотя бы одно.`,walkthrough:`Первое условие: 5 > 1 верно. Второе: 5 < 3 неверно. Для or достаточно одного верного, поэтому итог True.`,alt_examples:[{code:`n = 7
print(not n > 10)`,explain:`n > 10 неверно, а not переворачивает ответ. На экране True.`}],faq:[],transfer_question:{example:`n = 4
print(n > 5 or n < 2)`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`True`,`False`,`Не знаю`],help_option:`Не знаю`,accept:[`False`],misconceptions:[{id:`or_as_and`,match:[`True`],hint:`Для or нужно, чтобы хотя бы одно условие было верным. Проверь оба по отдельности.`,followup:`Верно ли, что 4 больше 5? А что 4 меньше 2?`}],from_example:!1,vocabulary:!0}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}}],practice:[{id:`P1`,ladder_step:1,mode:`guided`,concepts:[`C3`],prompt:`Прочитай целое число. Если оно больше 10, выведи слово Большое. Если нет — ничего не выводи.`,starter_code:null,expected:[],tests:[{inputs:[`15`],output:[`Большое`],call:null},{inputs:[`5`],output:[],call:null},{inputs:[`10`],output:[],call:null}],must_use:[`if`],max_lines:4,hint:`Условие n > 10, потом двоеточие, а print — на новой строке с отступом из четырёх пробелов.`,example:`x = int(input())
if x > 0:
    print("Плюс")`},{id:`P2`,ladder_step:2,mode:`guided`,concepts:[`C4`],prompt:`Прочитай возраст. Если он 18 или больше, выведи Взрослый, иначе выведи Ребёнок.`,starter_code:null,expected:[],tests:[{inputs:[`20`],output:[`Взрослый`],call:null},{inputs:[`12`],output:[`Ребёнок`],call:null},{inputs:[`18`],output:[`Взрослый`],call:null}],must_use:[`if`],max_lines:6,hint:`Условие age >= 18. Для другого случая используй else: и отступ.`,example:`n = int(input())
if n > 0:
    print("Плюс")
else:
    print("Не плюс")`},{id:`P3`,ladder_step:3,mode:`independent`,concepts:[`C4`],prompt:`Прочитай количество баллов. Если баллов 90 и больше, выведи Отлично. Если 70 и больше — Хорошо. Иначе выведи Надо повторить.`,starter_code:null,expected:[],tests:[{inputs:[`95`],output:[`Отлично`],call:null},{inputs:[`90`],output:[`Отлично`],call:null},{inputs:[`75`],output:[`Хорошо`],call:null},{inputs:[`70`],output:[`Хорошо`],call:null},{inputs:[`30`],output:[`Надо повторить`],call:null}],must_use:[`if`],max_lines:8,hint:`Три варианта: if для первого условия, elif для второго, else для всех остальных.`,example:`n = int(input())
if n > 100:
    print("Много")
elif n > 10:
    print("Средне")
else:
    print("Мало")`},{id:`P4`,ladder_step:4,mode:`independent`,concepts:[`C5`],prompt:`Скидка на билет положена детям младше 12 лет или людям старше 65. Прочитай возраст и выведи Скидка или Без скидки.`,starter_code:null,expected:[],tests:[{inputs:[`10`],output:[`Скидка`],call:null},{inputs:[`70`],output:[`Скидка`],call:null},{inputs:[`30`],output:[`Без скидки`],call:null},{inputs:[`12`],output:[`Без скидки`],call:null},{inputs:[`65`],output:[`Без скидки`],call:null}],must_use:[`logic`],max_lines:6,hint:`Соедини два условия словом or: age < 12 or age > 65.`,example:`n = int(input())
if n < 0 or n > 100:
    print("Вне диапазона")`},{id:`P5`,ladder_step:5,mode:`independent`,concepts:[`C1`,`C4`],prompt:`Прочитай целое число и выведи Чётное или Нечётное. Подсказка: остаток от деления на 2 равен нулю у чётных чисел.`,starter_code:null,expected:[],tests:[{inputs:[`4`],output:[`Чётное`],call:null},{inputs:[`7`],output:[`Нечётное`],call:null},{inputs:[`0`],output:[`Чётное`],call:null}],must_use:[`if`,`arith2`],max_lines:6,hint:`Условие: n % 2 == 0 (два знака равно, потому что это сравнение).`,example:null}],project:{id:`MP5`,title:`Билетная касса`,intro:`Соберём кассу музея. Она спросит возраст и день недели, определит цену билета и скажет, выходной ли сегодня.`,max_lines:14,steps:[{id:`M1`,kind:`code`,prompt:`Спроси возраст и сохрани его числом в переменную age.`,requires:[`C3`],adds:[],tests:[{inputs:[`30`],output:[`31`],call:`print(age + 1)`}],must_use:[],inputs:[],hint:`age = int(input(...))`},{id:`M2`,kind:`code`,prompt:`Создай переменную price со значением 300. Если возраст меньше 7, поменяй price на 0. В конце выведи строку Цена билета: 300.`,requires:[`C3`],adds:[],tests:[{inputs:[`30`],output:[`Цена билета: 300`],call:null},{inputs:[`5`],output:[`Цена билета: 0`],call:null}],must_use:[`if`],inputs:[],hint:`Сначала price = 300, потом if age < 7: и на новой строке с отступом price = 0. print стоит без отступа.`},{id:`M3`,kind:`code`,prompt:`Добавь вариант для школьников: если возраст меньше 18 (но не меньше 7), цена 150.`,requires:[`C4`],adds:[],tests:[{inputs:[`30`],output:[`Цена билета: 300`],call:null},{inputs:[`5`],output:[`Цена билета: 0`],call:null},{inputs:[`10`],output:[`Цена билета: 150`],call:null},{inputs:[`7`],output:[`Цена билета: 150`],call:null}],must_use:[],inputs:[],hint:`Между if и print добавь elif age < 18: и ниже с отступом price = 150.`},{id:`M4`,kind:`code`,prompt:`Спроси день недели (слово маленькими буквами) в переменную day. Если это суббота или воскресенье, выведи ещё строку Сегодня выходной.`,requires:[`C5`],adds:[],tests:[{inputs:[`30`,`суббота`],output:[`Цена билета: 300`,`Сегодня выходной`],call:null},{inputs:[`30`,`воскресенье`],output:[`Цена билета: 300`,`Сегодня выходной`],call:null},{inputs:[`30`,`среда`],output:[`Цена билета: 300`],call:null}],must_use:[`logic`],inputs:[],hint:`Условие: day == "суббота" or day == "воскресенье" — каждое сравнение пишется целиком.`},{id:`M5`,kind:`predict_output`,prompt:`Допустим, пользователь ввёл 12 и воскресенье. Напиши, что программа покажет на экране. Каждая строка — с новой строки.`,requires:[`C4`],adds:[],tests:[],must_use:[],inputs:[`12`,`воскресенье`],hint:`Сначала определи цену для возраста 12, потом проверь день недели.`}],outro:`Готово: касса сама выбирает цену и проверяет день недели. Любая программа, которая «думает» и выбирает, строится на таких условиях.`},assignment:{id:`T5`,title:`Тариф службы доставки`,level:`Среднее`,summary:`Определяет стоимость доставки по весу посылки и опции срочности.`,brief:`Заказчик: курьерская служба. Нужна программа расчёта стоимости доставки.

Тариф по весу посылки: до 1 кг включительно — 200 рублей, до 5 кг включительно — 350, до 20 кг включительно — 600. Тяжелее 20 кг мы не возим. Срочная доставка стоит на 150 рублей дороже.

Программа спрашивает вес (целое число) и «Срочная доставка (да/нет)».

Пример 1. Ввод: 3, да. Вывод: Стоимость доставки: 500
Пример 2. Ввод: 25, нет. Вывод: Груз слишком тяжёлый`,requirements:[`Два ввода: вес как целое число, затем слово да или нет`,`Используй if, elif и else`,`Границы тарифа включительно: ровно 1, 5 и 20 кг относятся к своему тарифу`,`Для слишком тяжёлого груза выведи только: Груз слишком тяжёлый (без стоимости)`,`Стоимость выводи в формате: Стоимость доставки: число`],plan:[`Прочитай вес и ответ про срочность двумя input.`,`Выбери цену по весу цепочкой if / elif / else.`,`Слишком тяжёлый груз обработай отдельно: вывод без стоимости.`,`Для срочной доставки добавь 150 и выведи стоимость в нужном формате.`],warmup:{prompt:`Спроси возраст (целое число). Если возраст 18 или больше, выведи Можно, иначе выведи Нельзя.`,tests:[{inputs:[`17`],output:[`Нельзя`],call:null},{inputs:[`18`],output:[`Можно`],call:null},{inputs:[`30`],output:[`Можно`],call:null}],must_use:[`if`],max_lines:8,hint:`age = int(input(...)), потом if age >= 18: ... else: ...`},tests:[{inputs:[`3`,`да`],output:[`Стоимость доставки: 500`],call:null},{inputs:[`25`,`нет`],output:[`Груз слишком тяжёлый`],call:null},{inputs:[`1`,`нет`],output:[`Стоимость доставки: 200`],call:null},{inputs:[`5`,`нет`],output:[`Стоимость доставки: 350`],call:null},{inputs:[`20`,`да`],output:[`Стоимость доставки: 750`],call:null},{inputs:[`21`,`да`],output:[`Груз слишком тяжёлый`],call:null},{inputs:[`8`,`нет`],output:[`Стоимость доставки: 600`],call:null}],must_use:[`if`,`compare`],max_lines:20,hint:`Сначала определи цену по весу цепочкой if / elif / else, потом при ответе да прибавь 150. Тяжёлый груз обработай отдельным условием.`},code_feedback:{syntax_error:`Python не смог прочитать эту строку. Чаще всего не хватает кавычки или скобки — проверь, что у каждой открывающей есть закрывающая.`,too_many_lines:`Здесь нужно меньше строк. Оставь только то, о чём просит задание.`,not_learned_yet:`В коде есть то, что мы ещё не проходили. Попробуй решить задание тем, что уже знаешь.`,missing_assignment:`Не вижу строки, где значение сохраняется в нужную переменную.`,wrong_variable_name:`Имя переменной отличается от того, что в задании. Проверь, как оно пишется.`,missing_quotes:`Без кавычек Python считает слово именем другой переменной и ищет её. Текст нужно взять в кавычки.`,empty_text:`Между кавычками пусто. Напиши текст внутри них.`,string_instead_of_number:`Число в кавычках Python считает текстом. Здесь нужно именно число, поэтому кавычки не нужны.`,number_instead_of_string:`Здесь нужен текст, поэтому значение пишется в кавычках.`,number_out_of_range:`Число выглядит необычно для этого задания. Проверь его ещё раз.`,missing_print:`Значение сохранено, но на экран оно не выводится. Для этого нужен print.`,printed_literal_instead_of_variable:`В скобках print стоит текст в кавычках, поэтому на экран выведется само это слово. Чтобы вывести значение переменной, напиши её имя без кавычек.`,unchanged_starter:`Строка пока осталась такой же, как была. Измени её по заданию.`,wrong_output:`Программа работает, но результат не тот, что нужен. Сравни, что ожидалось и что получилось.`,runtime_error:`Программа остановилась с ошибкой. Прочитай, что случилось, и исправь это место.`,too_slow:`Программа не закончила работу. Скорее всего, цикл никогда не останавливается.`,missing_construct:`Задание нужно решить с помощью темы урока. Посмотри, что именно требуется.`,empty_code:`Поле пустое. Напиши программу по заданию и нажми «Проверить».`}},{id:`L6`,version:1,title:`Циклы`,welcome:`Урок 6. Компьютеры хороши в одном: они не устают повторять одно и то же. Сегодня научимся просить Python повторять действия столько раз, сколько нужно, и не писать одну и ту же строку десять раз подряд.`,features:[`for`,`while`,`range`,`loopctl`],phrases:{greeting:`Привет! Я твой преподаватель программирования. Учиться будем маленькими шагами: я объясняю одну мысль, показываю короткий пример и задаю один вопрос. Если что-то непонятно — просто напиши об этом, это нормальная часть обучения.`,correct:[`Верно.`,`Да, правильно.`,`Точно.`],correct_after_help:`Верно. Закрепим на новом примере.`,clarify:`Я не совсем понял сообщение. Это ответ на вопрос или мне объяснить по-другому?`,off_topic:`Давай вернёмся к уроку — так ты быстрее дойдёшь до своей первой программы.`,return_to_question:`Вернёмся к вопросу:`,not_learned_yet:`Хороший вопрос, но для этого нужны темы, которых мы ещё не проходили. Мы дойдём до них в следующих уроках.`,dont_know:`Ничего страшного, разберём вместе.`,assessment_help:`Это проверочный вопрос, поэтому ответ я не подскажу. Напомню главное:`,why_fallback:`Хороший вопрос. Чтобы не сбиться, давай сначала закончим этот шаг, а потом вернёмся к нему.`,practice_intro:`Теперь попробуй написать код сам. Пиши прямо в поле в сообщении. Кнопка «Запустить» покажет, что выведет программа, а «Проверить» отправит решение на проверку.`,practice_correct:`Код правильный.`,project_paused:`Для этого шага пригодится тема, которую стоит повторить. Повторим её и сразу вернёмся к проекту.`,project_resumed:`Возвращаемся к проекту.`,concept_mastered:`Тема освоена:`,lesson_complete:`Урок пройден. Теперь программы умеют повторять действия сами.`,how_to_use:`Как это работает. Я объясняю, а ты отвечаешь: нажимай на кнопки с ответами или пиши своими словами в строке внизу. Если что-то непонятно, нажми «Объясни проще», и я объясню по-другому. Ошибаться можно, так и учатся.`,transfer_intro:`Теперь тот же вопрос на новом примере.`,try_again:`Попробуй ещё раз.`,concepts_done:`Все темы урока разобраны. Теперь потренируемся писать код самому.`,practice_retry:`Исправь код и отправь снова.`,hint_no_open:`Сейчас у меня нет открытого вопроса. Можно задать вопрос по теме или нажать «Повтори».`,next_lessons:`Этот урок уже пройден. Любой урок можно повторить: открой «Мой путь» на главном экране.`,review_intro:`Вернёмся к теме «{title}». Сначала напомню главное.`,predict_reveal:`Вот что будет на экране:`,reteach_intro:`Объясню по-другому.`,assignment_intro:`Это тестовое задание. Прочитай условие и требования, а план решения подскажет, с чего начать. Принятое решение попадёт в твоё портфолио.`,warmup_intro:`Впереди тестовое задание, как на собеседовании или от заказчика. Сначала разминка: маленькая задача на ту же тему, чтобы войти в ритм. Подсказка доступна всегда.`,warmup_done:`Разминка пройдена. Теперь само задание.`},concepts:[{id:`C1`,key:`for_range`,title:`Цикл for и range`,goal:`Ученик понимает, что range(3) даёт три значения, начиная с нуля.`,explain:`Цикл повторяет код несколько раз. Запись for i in range(3): повторяет вложенный код три раза. Строки цикла пишутся с отступом, как в if. Переменная i получает значения по очереди, и первое из них — ноль.`,example:`for i in range(3):
    print(i)`,question:{kind:`gating`,format:`choice`,meaning:`Какое число выведется последним?`,match_mode:`text`,options:[`2`,`3`,`Не знаю`],help_option:`Не знаю`,accept:[`2`,`два`],misconceptions:[{id:`counted_from_one`,match:[`3`],hint:`Счёт начинается с нуля, поэтому три значения идут как ноль, один, и ещё одно.`,followup:`Какое по счёту значение стоит третьим, если первое — ноль?`}],from_example:!1,vocabulary:!1},reteach:`range(3) выдаёт три числа по порядку, но счёт начинается с нуля. Поэтому числа такие: ноль, один и следующее за ними.`,walkthrough:`range(3) даёт числа 0, 1, 2. Цикл повторяется три раза, и i по очереди принимает эти значения. Последнее из них — 2.`,alt_examples:[{code:`for i in range(2):
    print("Привет")`,explain:`Слово Привет появится на экране столько раз, сколько указано в скобках range.`}],faq:[{keywords:[`что такое i`,`зачем i`,`почему i`],answer:`i — просто имя переменной, которая хранит номер повторения. Можно назвать её иначе, но программисты любят короткое i.`}],transfer_question:{example:`for i in range(5):
    print(i)`,question:{kind:`gating`,format:`input`,meaning:`Какое число выведется последним?`,match_mode:`text`,options:[],help_option:null,accept:[`4`,`четыре`],misconceptions:[{id:`counted_from_one`,match:[`5`,`пять`],hint:`Счёт начинается с нуля, поэтому последнее число на единицу меньше, чем в скобках range.`,followup:`С какого числа начинается счёт в range?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C2`,key:`range_start_stop`,title:`range с началом и концом`,goal:`Ученик понимает, что в range(a, b) правая граница не входит.`,explain:`В range можно указать начало и конец: range(2, 5) начинается с двойки и останавливается перед пятёркой. Правая граница в диапазон не входит.`,example:`for n in range(1, 4):
    print(n)`,question:{kind:`gating`,format:`choice`,meaning:`Какое число выведется последним?`,match_mode:`text`,options:[`3`,`4`,`Не знаю`],help_option:`Не знаю`,accept:[`3`,`три`],misconceptions:[{id:`end_included`,match:[`4`],hint:`Правая граница не входит в диапазон: счёт останавливается перед ней.`,followup:`Какое число стоит прямо перед правой границей?`}],from_example:!1,vocabulary:!1},reteach:`Представь забор из досок: range(1, 4) красит доски, начиная с первой, и останавливается перед четвёртой, не трогая её.`,walkthrough:`range(1, 4) начинает с 1 и останавливается перед 4: значит, получаются числа 1, 2 и 3. Последнее — 3.`,alt_examples:[{code:`for n in range(5, 8):
    print(n)`,explain:`Выведутся числа 5, 6 и 7. Число 8 не входит.`}],faq:[],transfer_question:{example:`for n in range(10, 13):
    print(n)`,question:{kind:`gating`,format:`input`,meaning:`Какое число выведется последним?`,match_mode:`text`,options:[],help_option:null,accept:[`12`,`двенадцать`],misconceptions:[{id:`end_included`,match:[`13`,`тринадцать`],hint:`Правая граница в диапазон не входит.`,followup:`Какое число идёт прямо перед правой границей?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`independent`],after_error:[`transfer`],independent_task:`P2`}},{id:`C3`,key:`while_loop`,title:`Цикл while`,goal:`Ученик понимает, что while повторяет код, пока условие верно, и условие нужно менять внутри цикла.`,explain:`Цикл while повторяет код, пока условие верно. Перед каждым повтором Python проверяет условие заново. Если внутри цикла ничего не менять, условие навсегда останется верным, и цикл никогда не закончится. Поэтому внутри цикла значение из условия обязательно обновляют.`,example:`n = 3
while n > 0:
    print(n)
    n -= 1`,question:{kind:`gating`,format:`choice`,meaning:`Какое число выведется последним?`,match_mode:`text`,options:[`0`,`1`,`Не знаю`],help_option:`Не знаю`,accept:[`1`,`один`],misconceptions:[{id:`ran_to_zero`,match:[`0`],hint:`Условие проверяется перед каждым повтором. Когда переменная станет равна нулю, условие уже будет неверным, и print не выполнится.`,followup:`Верно ли условие n > 0, когда n равно нулю?`}],from_example:!1,vocabulary:!1},reteach:`while — как «пока не...». Пока условие верно, Python продолжает повторять. Как только оно стало неверным, он выходит из цикла, не доходя до тела цикла.`,walkthrough:`Сначала n равно 3 — выводим 3 и уменьшаем до 2. Потом выводим 2 и уменьшаем до 1. Выводим 1 и уменьшаем до нуля. Теперь n > 0 неверно, цикл заканчивается. Последнее выведенное число — 1.`,alt_examples:[{code:`n = 2
while n > 0:
    print("Раз")
    n -= 1`,explain:`Цикл выполнится два раза, потому что n сначала равно двум, потом одному, а потом нулю.`}],faq:[{keywords:[`бесконеч`,`завис`,`не заканчива`],answer:`Если условие в while никогда не станет неверным, цикл бесконечный. В нашей школе такая программа остановится сама, но в обычной среде придётся её прерывать вручную.`}],transfer_question:{example:`n = 5
while n > 2:
    print(n)
    n -= 1`,question:{kind:`gating`,format:`input`,meaning:`Какое число выведется последним?`,match_mode:`text`,options:[],help_option:null,accept:[`3`,`три`],misconceptions:[{id:`ran_to_zero`,match:[`2`,`два`],hint:`Проверь условие для двойки: верно ли, что 2 больше второго числа?`,followup:`Можно ли выполнять тело цикла, когда условие неверно?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C4`,key:`accumulator`,title:`Накопление суммы`,goal:`Ученик понимает схему: переменная с нулём до цикла, прибавление в цикле, вывод после цикла.`,explain:`Цикл часто используют, чтобы накапливать результат. Перед циклом заводят переменную с нулём. На каждом повторе прибавляют к ней новое число. Показывают итог после цикла, без отступа, когда все повторы уже выполнены.`,example:`total = 0
for i in range(1, 4):
    total += i
print(total)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`6`,`шесть`],misconceptions:[{id:`last_value_only`,match:[`3`,`три`],hint:`total накапливает сумму всех чисел, а не хранит только последнее.`,followup:`Какие числа прибавляются к total за три повтора?`},{id:`not_changed`,match:[`0`,`ноль`],hint:`Ноль лежит в total только до цикла. На каждом повторе к нему прибавляется число.`,followup:`Что лежит в total после трёх прибавлений?`}],from_example:!0,vocabulary:!1},reteach:`Это копилка. Сначала она пустая (ноль). На каждом повторе в неё кладут новую монету. Посчитать итог можно только после того, как все монеты положены.`,walkthrough:`Сначала total = 0. Затем i по очереди равно 1, 2, 3. К total прибавляются эти числа: 0 + 1 + 2 + 3. Итог — 6, его и показывает print после цикла.`,alt_examples:[{code:`s = 0
for i in range(1, 3):
    s += i * 10
print(s)`,explain:`Каждое число сначала умножается, а потом прибавляется к сумме. Итог на экране — 30.`}],faq:[],transfer_question:{example:`total = 0
for i in range(1, 5):
    total += i
print(total)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`10`,`десять`],misconceptions:[{id:`end_included`,match:[`15`,`пятнадцать`],hint:`Правая граница в range не входит, поэтому пятёрка не прибавляется.`,followup:`Какие числа проходит i в этом цикле?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P4`}},{id:`C5`,key:`break_continue`,title:`break и continue`,goal:`Ученик понимает: break выходит из цикла, continue пропускает текущий повтор.`,explain:`Цикл можно прервать. Слово break немедленно выходит из цикла целиком. Слово continue пропускает остаток текущего повтора и переходит к следующему. Обычно их пишут внутри if.`,example:`for i in range(1, 10):
    if i == 3:
        break
    print(i)`,question:{kind:`gating`,format:`choice`,meaning:`Сколько чисел выведется на экран?`,match_mode:`text`,options:[`2`,`3`,`9`,`Не знаю`],help_option:`Не знаю`,accept:[`2`,`два`],misconceptions:[{id:`break_late`,match:[`3`],hint:`Когда i становится равным числу из условия, break срабатывает сразу, до print.`,followup:`Выведется ли число, на котором сработал break?`},{id:`ignored_break`,match:[`9`],hint:`break прерывает цикл целиком, остальные повторы не выполняются.`,followup:`Что делает break с оставшимися повторами?`}],from_example:!1,vocabulary:!1},reteach:`break — аварийный выход из цикла. Как только Python его встречает, он покидает цикл, даже если повторы ещё не закончились.`,walkthrough:`i = 1: условие неверно, выводится 1. i = 2: условие неверно, выводится 2. i = 3: условие верно, break прерывает цикл до print. Всего выведено два числа.`,alt_examples:[{code:`for i in range(1, 4):
    if i == 2:
        continue
    print(i)`,explain:`Когда i равно двум, continue пропускает print. Остальные числа выведутся.`}],faq:[{keywords:[`разница`,`отличие`],answer:`break выходит из цикла насовсем, а continue только пропускает текущий повтор и идёт дальше.`}],transfer_question:{example:`for i in range(1, 5):
    if i == 2:
        continue
    print(i)`,question:{kind:`gating`,format:`input`,meaning:`Сколько чисел выведется на экран? Ответь числом.`,match_mode:`text`,options:[],help_option:null,accept:[`3`,`три`],misconceptions:[{id:`continue_as_break`,match:[`1`,`одно`],hint:`continue пропускает только текущий повтор, а не весь цикл.`,followup:`Что делает цикл после пропуска повтора?`},{id:`no_skip`,match:[`4`,`четыре`],hint:`Один повтор пропускается, поэтому print выполняется на один раз меньше, чем повторов.`,followup:`Сколько всего повторов и сколько из них пропущено?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}}],practice:[{id:`P1`,ladder_step:1,mode:`guided`,concepts:[`C1`],prompt:`С помощью цикла выведи слово Привет пять раз, каждый раз с новой строки.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`Привет`,`Привет`,`Привет`,`Привет`,`Привет`],call:null}],must_use:[`for`],max_lines:3,hint:`for i in range(5): и на следующей строке с отступом print("Привет").`,example:`for i in range(2):
    print("Ура")`},{id:`P2`,ladder_step:2,mode:`independent`,concepts:[`C2`],prompt:`Выведи числа от 1 до 5 включительно, каждое с новой строки.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`1`,`2`,`3`,`4`,`5`],call:null}],must_use:[`range`],max_lines:3,hint:`Правая граница в range не входит, поэтому для пятёрки нужно указать шесть.`,example:`for k in range(3, 6):
    print(k)`},{id:`P3`,ladder_step:3,mode:`guided`,concepts:[`C3`],prompt:`Прочитай целое число n и сделай обратный отсчёт: выведи числа от n до 1 (каждое с новой строки), а потом слово Старт!`,starter_code:null,expected:[],tests:[{inputs:[`3`],output:[`3`,`2`,`1`,`Старт!`],call:null},{inputs:[`1`],output:[`1`,`Старт!`],call:null}],must_use:[`while`],max_lines:6,hint:`Цикл while n > 0: выводит n и уменьшает его. Слово Старт! печатается после цикла, без отступа.`,example:`k = 2
while k > 0:
    print("Раз")
    k -= 1`},{id:`P4`,ladder_step:4,mode:`independent`,concepts:[`C4`],prompt:`Прочитай целое число n и выведи сумму всех чисел от 1 до n.`,starter_code:null,expected:[],tests:[{inputs:[`4`],output:[`10`],call:null},{inputs:[`10`],output:[`55`],call:null},{inputs:[`1`],output:[`1`],call:null}],must_use:[`for`],max_lines:6,hint:`Заведи total = 0, прибавляй i в цикле по range(1, n + 1), а print напиши после цикла.`,example:`s = 0
for i in range(1, 4):
    s += i
print(s)`},{id:`P5`,ladder_step:5,mode:`guided`,concepts:[`C5`],prompt:`Выведи числа от 1 до 10, но число 5 пропусти.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`1`,`2`,`3`,`4`,`6`,`7`,`8`,`9`,`10`],call:null}],must_use:[`loopctl`],max_lines:5,hint:`Внутри цикла поставь if i == 5: и на следующей строке continue.`,example:`for i in range(1, 4):
    if i == 2:
        continue
    print(i)`},{id:`P6`,ladder_step:6,mode:`independent`,concepts:[`C1`,`C2`],prompt:`Прочитай число n и выведи таблицу умножения на n от 1 до 5. Каждая строка выглядит так: 3 x 1 = 3 (для n = 3).`,starter_code:null,expected:[],tests:[{inputs:[`3`],output:[`3 x 1 = 3`,`3 x 2 = 6`,`3 x 3 = 9`,`3 x 4 = 12`,`3 x 5 = 15`],call:null},{inputs:[`7`],output:[`7 x 1 = 7`,`7 x 2 = 14`,`7 x 3 = 21`,`7 x 4 = 28`,`7 x 5 = 35`],call:null}],must_use:[`for`,`fstring`],max_lines:4,hint:`Внутри цикла выводи f-строку: f"{n} x {i} = {n * i}".`,example:null}],project:{id:`MP6`,title:`Копилка`,intro:`Построим программу-копилку: человек называет цель, а программа каждый месяц откладывает по 100 и считает, за сколько месяцев цель накопится.`,max_lines:12,steps:[{id:`M1`,kind:`code`,prompt:`Прочитай цель накопления в переменную goal (целое число). Создай переменные saved и month, обе равны нулю.`,requires:[`C4`],adds:[],tests:[{inputs:[`500`],output:[`500 0 0`],call:`print(goal, saved, month)`}],must_use:[],inputs:[],hint:`Три строки: goal = int(input(...)), saved = 0, month = 0.`},{id:`M2`,kind:`code`,prompt:`Добавь цикл while: пока saved меньше goal, увеличивай month на 1 и прибавляй к saved по 100.`,requires:[`C3`],adds:[],tests:[{inputs:[`500`],output:[`5`],call:`print(month)`},{inputs:[`250`],output:[`3`],call:`print(month)`}],must_use:[`while`],inputs:[],hint:`Условие цикла: saved < goal. Внутри с отступом две строки: month += 1 и saved += 100.`},{id:`M3`,kind:`code`,prompt:`После цикла выведи строку в таком виде: Накопим за 5 мес.`,requires:[`C4`],adds:[],tests:[{inputs:[`500`],output:[`Накопим за 5 мес.`],call:null},{inputs:[`250`],output:[`Накопим за 3 мес.`],call:null}],must_use:[],inputs:[],hint:`print стоит без отступа, после цикла. Используй f-строку с {month}.`},{id:`M4`,kind:`code`,prompt:`Внутри цикла после прибавления выводи строку для каждого месяца: Месяц 1: 100 (номер месяца и сколько накоплено).`,requires:[`C3`],adds:[],tests:[{inputs:[`300`],output:[`Месяц 1: 100`,`Месяц 2: 200`,`Месяц 3: 300`,`Накопим за 3 мес.`],call:null},{inputs:[`150`],output:[`Месяц 1: 100`,`Месяц 2: 200`,`Накопим за 2 мес.`],call:null}],must_use:[],inputs:[],hint:`Новый print вставь внутрь цикла, с тем же отступом, что и saved += 100, и после этой строки.`},{id:`M5`,kind:`predict_output`,prompt:`Допустим, человек ввёл 200. Напиши, что программа покажет на экране. Каждая строка — с новой строки.`,requires:[`C3`],adds:[],tests:[],must_use:[],inputs:[`200`],hint:`Пройди цикл по шагам: на каждом повторе меняются month и saved.`}],outro:`Готово: программа сама повторяет шаги, пока цель не достигнута. Именно такие циклы стоят за подсчётами, играми и обработкой данных.`},assignment:{id:`T6`,title:`Прогноз роста вклада`,level:`Среднее`,summary:`Показывает, как растёт вклад месяц за месяцем с процентами, и выводит итог.`,brief:`Заказчик: небольшой банк. Нужна программа, которая показывает клиенту, как вырастет его вклад. Каждый месяц к сумме прибавляется процент от текущей суммы (целая часть: используй //).

Программа спрашивает: сумму вклада, ставку в процентах за месяц и количество месяцев (всё целые числа).

Пример. Ввод: 1000, 10, 3. Вывод:
Месяц 1: 1100
Месяц 2: 1210
Месяц 3: 1331
Итого: 1331`,requirements:[`Три ввода в таком порядке: сумма, ставка, месяцы`,`Используй цикл for с range`,`Каждый месяц: сумма += сумма * ставка // 100`,`Выведи строку Месяц N: сумма для каждого месяца и в конце Итого: сумма`,`Если месяцев ноль, выведи только строку Итого`],plan:[`Прочитай сумму, ставку и количество месяцев тремя input, все числа целые.`,`Запусти цикл for month in range(1, months + 1).`,`Внутри цикла увеличь сумму на процент и выведи строку месяца.`,`После цикла выведи строку с итогом.`],warmup:{prompt:`Выведи числа от 1 до 5, каждое на своей строке. Используй цикл.`,tests:[{inputs:[],output:[`1`,`2`,`3`,`4`,`5`],call:null}],must_use:[`for`,`range`],max_lines:4,hint:`for n in range(1, 6): и внутри цикла print(n).`},tests:[{inputs:[`1000`,`10`,`3`],output:[`Месяц 1: 1100`,`Месяц 2: 1210`,`Месяц 3: 1331`,`Итого: 1331`],call:null},{inputs:[`500`,`5`,`2`],output:[`Месяц 1: 525`,`Месяц 2: 551`,`Итого: 551`],call:null},{inputs:[`100`,`0`,`2`],output:[`Месяц 1: 100`,`Месяц 2: 100`,`Итого: 100`],call:null},{inputs:[`2000`,`3`,`0`],output:[`Итого: 2000`],call:null},{inputs:[`750`,`12`,`4`],output:[`Месяц 1: 840`,`Месяц 2: 940`,`Месяц 3: 1052`,`Месяц 4: 1178`,`Итого: 1178`],call:null}],must_use:[`for`,`range`,`fstring`],max_lines:10,hint:`Цикл for month in range(1, months + 1): внутри обнови amount и выведи строку месяца. Итог печатается после цикла.`},code_feedback:{syntax_error:`Python не смог прочитать эту строку. Чаще всего не хватает кавычки или скобки — проверь, что у каждой открывающей есть закрывающая.`,too_many_lines:`Здесь нужно меньше строк. Оставь только то, о чём просит задание.`,not_learned_yet:`В коде есть то, что мы ещё не проходили. Попробуй решить задание тем, что уже знаешь.`,missing_assignment:`Не вижу строки, где значение сохраняется в нужную переменную.`,wrong_variable_name:`Имя переменной отличается от того, что в задании. Проверь, как оно пишется.`,missing_quotes:`Без кавычек Python считает слово именем другой переменной и ищет её. Текст нужно взять в кавычки.`,empty_text:`Между кавычками пусто. Напиши текст внутри них.`,string_instead_of_number:`Число в кавычках Python считает текстом. Здесь нужно именно число, поэтому кавычки не нужны.`,number_instead_of_string:`Здесь нужен текст, поэтому значение пишется в кавычках.`,number_out_of_range:`Число выглядит необычно для этого задания. Проверь его ещё раз.`,missing_print:`Значение сохранено, но на экран оно не выводится. Для этого нужен print.`,printed_literal_instead_of_variable:`В скобках print стоит текст в кавычках, поэтому на экран выведется само это слово. Чтобы вывести значение переменной, напиши её имя без кавычек.`,unchanged_starter:`Строка пока осталась такой же, как была. Измени её по заданию.`,wrong_output:`Программа работает, но результат не тот, что нужен. Сравни, что ожидалось и что получилось.`,runtime_error:`Программа остановилась с ошибкой. Прочитай, что случилось, и исправь это место.`,too_slow:`Программа не закончила работу. Скорее всего, цикл никогда не останавливается.`,missing_construct:`Задание нужно решить с помощью темы урока. Посмотри, что именно требуется.`,empty_code:`Поле пустое. Напиши программу по заданию и нажми «Проверить».`}},{id:`L7`,version:1,title:`Списки`,welcome:`Урок 7. Пока каждое значение жило в своей переменной. А если значений много: оценки за четверть, список покупок, имена друзей? Для этого в Python есть списки — коробка, в которой лежит много значений сразу.`,features:[`list`],phrases:{greeting:`Привет! Я твой преподаватель программирования. Учиться будем маленькими шагами: я объясняю одну мысль, показываю короткий пример и задаю один вопрос. Если что-то непонятно — просто напиши об этом, это нормальная часть обучения.`,correct:[`Верно.`,`Да, правильно.`,`Точно.`],correct_after_help:`Верно. Закрепим на новом примере.`,clarify:`Я не совсем понял сообщение. Это ответ на вопрос или мне объяснить по-другому?`,off_topic:`Давай вернёмся к уроку — так ты быстрее дойдёшь до своей первой программы.`,return_to_question:`Вернёмся к вопросу:`,not_learned_yet:`Хороший вопрос, но для этого нужны темы, которых мы ещё не проходили. Мы дойдём до них в следующих уроках.`,dont_know:`Ничего страшного, разберём вместе.`,assessment_help:`Это проверочный вопрос, поэтому ответ я не подскажу. Напомню главное:`,why_fallback:`Хороший вопрос. Чтобы не сбиться, давай сначала закончим этот шаг, а потом вернёмся к нему.`,practice_intro:`Теперь попробуй написать код сам. Пиши прямо в поле в сообщении. Кнопка «Запустить» покажет, что выведет программа, а «Проверить» отправит решение на проверку.`,practice_correct:`Код правильный.`,project_paused:`Для этого шага пригодится тема, которую стоит повторить. Повторим её и сразу вернёмся к проекту.`,project_resumed:`Возвращаемся к проекту.`,concept_mastered:`Тема освоена:`,lesson_complete:`Урок пройден. Теперь программы умеют хранить и обрабатывать много значений.`,how_to_use:`Как это работает. Я объясняю, а ты отвечаешь: нажимай на кнопки с ответами или пиши своими словами в строке внизу. Если что-то непонятно, нажми «Объясни проще», и я объясню по-другому. Ошибаться можно, так и учатся.`,transfer_intro:`Теперь тот же вопрос на новом примере.`,try_again:`Попробуй ещё раз.`,concepts_done:`Все темы урока разобраны. Теперь потренируемся писать код самому.`,practice_retry:`Исправь код и отправь снова.`,hint_no_open:`Сейчас у меня нет открытого вопроса. Можно задать вопрос по теме или нажать «Повтори».`,next_lessons:`Этот урок уже пройден. Любой урок можно повторить: открой «Мой путь» на главном экране.`,review_intro:`Вернёмся к теме «{title}». Сначала напомню главное.`,predict_reveal:`Вот что будет на экране:`,reteach_intro:`Объясню по-другому.`,assignment_intro:`Это тестовое задание. Прочитай условие и требования, а план решения подскажет, с чего начать. Принятое решение попадёт в твоё портфолио.`,warmup_intro:`Впереди тестовое задание, как на собеседовании или от заказчика. Сначала разминка: маленькая задача на ту же тему, чтобы войти в ритм. Подсказка доступна всегда.`,warmup_done:`Разминка пройдена. Теперь само задание.`},concepts:[{id:`C1`,key:`list_index`,title:`Список и номера элементов`,goal:`Ученик понимает, что список хранит много значений, а номера идут с нуля.`,explain:`Список хранит несколько значений под одним именем. Его пишут в квадратных скобках, значения разделяют запятыми. Элементы нумеруются с нуля, как символы в тексте: чтобы достать элемент, пиши имя списка и номер в квадратных скобках.`,example:`fruits = ["яблоко", "груша", "слива"]
print(fruits[1])`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`яблоко`,`груша`,`слива`,`Не знаю`],help_option:`Не знаю`,accept:[`груша`],misconceptions:[{id:`counted_from_one`,match:[`яблоко`],hint:`Нумерация начинается с нуля, поэтому номер 1 — это не первый элемент.`,followup:`Какой номер у самого первого элемента?`},{id:`last_element`,match:[`слива`],hint:`Слива стоит последней, но номер 1 — второй по порядку.`,followup:`Какой элемент стоит под номером 0, а какой под номером 1?`}],from_example:!1,vocabulary:!1},reteach:`Список похож на ряд ячеек, пронумерованных с нуля. Номер в скобках — это номер ячейки, из которой Python достаёт значение.`,walkthrough:`Нумерация: яблоко — номер 0, груша — номер 1, слива — номер 2. В скобках стоит 1, значит, достаём грушу.`,alt_examples:[{code:`days = ["пн", "вт", "ср"]
print(days[0])`,explain:`Номер 0 — первый элемент, поэтому на экране появится пн.`}],faq:[{keywords:[`квадратн`,`скобк`],answer:`Квадратные скобки обозначают два разных действия: ими создают список и ими достают элемент по номеру. Python понимает по месту, что имеется в виду.`}],transfer_question:{example:`colors = ["красный", "зелёный", "синий"]
print(colors[2])`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`синий`],misconceptions:[{id:`counted_from_one`,match:[`красный`],hint:`Нумерация идёт с нуля, поэтому номер 2 — это не второй по порядку элемент.`,followup:`Сколько элементов стоит перед элементом с номером 2?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`independent`],after_error:[`transfer`],independent_task:`P1`}},{id:`C2`,key:`list_append_len`,title:`Длина и добавление`,goal:`Ученик понимает, что len считает элементы, а append добавляет один элемент в конец.`,explain:`Сколько в списке элементов, показывает len(). Новый элемент добавляют в конец списка методом append. Каждый вызов append добавляет ровно один элемент.`,example:`nums = [4, 8]
nums.append(15)
print(len(nums))`,question:{kind:`gating`,format:`choice`,meaning:`Что появится на экране?`,match_mode:`text`,options:[`2`,`3`,`15`,`Не знаю`],help_option:`Не знаю`,accept:[`3`,`три`],misconceptions:[{id:`length_not_updated`,match:[`2`],hint:`Строка с append добавила в список ещё один элемент, поэтому длина выросла.`,followup:`Сколько элементов в списке после добавления?`},{id:`last_value_printed`,match:[`15`],hint:`len() считает, сколько в списке элементов, а не показывает последний.`,followup:`Сколько всего элементов в списке?`}],from_example:!1,vocabulary:!1},reteach:`len — это пересчёт ячеек в ряду. append приставляет в конец ряда ещё одну ячейку со значением. Поэтому после append пересчёт покажет на единицу больше.`,walkthrough:`Сначала в списке два элемента: 4 и 8. Метод append добавляет 15 в конец, элементов становится три. len показывает 3.`,alt_examples:[{code:`names = ["Аня"]
names.append("Боря")
print(names)`,explain:`После append в списке будут оба имени: Аня и Боря.`}],faq:[],transfer_question:{example:`a = [1, 2, 3]
a.append(4)
a.append(5)
print(len(a))`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`5`,`пять`],misconceptions:[{id:`single_append`,match:[`4`,`четыре`],hint:`Метод append вызывается дважды, и каждый вызов добавляет по одному элементу.`,followup:`Сколько элементов было вначале и сколько добавили всего?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C3`,key:`list_loop`,title:`Цикл по списку`,goal:`Ученик понимает, что for проходит по элементам списка по очереди.`,explain:`Цикл for умеет проходить по списку: переменная цикла по очереди получает каждый элемент. Номера при этом не нужны. Так удобно обрабатывать все значения подряд, например складывать их.`,example:`prices = [10, 20, 30]
total = 0
for p in prices:
    total += p
print(total)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`60`,`шестьдесят`],misconceptions:[{id:`last_only`,match:[`30`,`тридцать`],hint:`total накапливает все значения, а не хранит только последнее.`,followup:`Какие значения по очереди прибавляются к total?`}],from_example:!0,vocabulary:!1},reteach:`Цикл берёт из списка по одному значению: сначала первое, потом второе и так до конца. На каждом шаге значение лежит в переменной цикла, и с ним можно делать что угодно.`,walkthrough:`p по очереди равно 10, 20, 30. К total прибавляется каждое: 0 + 10 + 20 + 30. Итог — 60.`,alt_examples:[{code:`for name in ["Аня", "Боря"]:
    print("Привет,", name)`,explain:`Цикл подставит в name сначала Аня, потом Боря, и приветствие выведется для каждого.`}],faq:[],transfer_question:{example:`prices = [5, 15, 25]
total = 0
for p in prices:
    total += p
print(total)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`45`,`сорок пять`],misconceptions:[{id:`last_only`,match:[`25`],hint:`total накапливает сумму всех значений, а не хранит только последнее.`,followup:`Какие значения по очереди прибавляются к total?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P5`}},{id:`C4`,key:`list_functions`,title:`sum, max и min`,goal:`Ученик понимает: sum — сумма, max — наибольшее, min — наименьшее.`,explain:`Для списков чисел есть готовые функции: sum() считает сумму всех элементов, max() возвращает наибольший элемент, min() — наименьший. Писать для этого цикл не нужно.`,example:`marks = [4, 5, 3, 5]
print(max(marks))
print(min(marks))`,question:{kind:`gating`,format:`choice`,meaning:`Что покажет вторая строка, с min?`,match_mode:`text`,options:[`3`,`5`,`4`,`Не знаю`],help_option:`Не знаю`,accept:[`3`,`три`],misconceptions:[{id:`max_instead_of_min`,match:[`5`],hint:`min возвращает наименьший элемент, а не наибольший.`,followup:`Какое число в списке самое маленькое?`}],from_example:!1,vocabulary:!1},reteach:`max и min — это «самый большой» и «самый маленький». Python сам просматривает весь список и выбирает нужный элемент.`,walkthrough:`В списке числа 4, 5, 3, 5. Наименьшее из них — 3. Первая строка с max покажет 5, вторая строка с min покажет 3.`,alt_examples:[{code:`nums = [2, 6, 1]
print(sum(nums))`,explain:`sum складывает все элементы списка. На экране будет 9.`}],faq:[],transfer_question:{example:`temps = [12, 7, 15]
print(min(temps))`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`7`,`семь`],misconceptions:[{id:`max_instead_of_min`,match:[`15`,`пятнадцать`],hint:`min возвращает наименьший элемент, а не наибольший.`,followup:`Какое число в списке самое маленькое?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C5`,key:`list_assign`,title:`Замена элемента`,goal:`Ученик понимает, что nums[0] = 10 заменяет элемент по номеру.`,explain:`Элемент списка можно заменить: напиши имя списка, номер в квадратных скобках, знак = и новое значение. Остальные элементы не меняются. Весь список целиком можно вывести через print.`,example:`nums = [1, 2, 3]
nums[0] = 10
print(nums)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши список так, как его показывает Python.`,match_mode:`code`,options:[],help_option:null,accept:[`[10, 2, 3]`],misconceptions:[{id:`not_replaced`,match:[`[1, 2, 3]`],hint:`Строка nums[0] = 10 заменяет элемент под номером 0 новым значением.`,followup:`Какое значение теперь лежит под номером 0?`}],from_example:!0,vocabulary:!1},reteach:`Это как поменять надпись в одной ячейке: выбираешь ячейку по номеру и кладёшь туда новое значение. Остальные ячейки остаются как были.`,walkthrough:`Сначала в списке 1, 2, 3. Строка nums[0] = 10 заменяет первый элемент на 10. Остальные не меняются, получается [10, 2, 3].`,alt_examples:[{code:`pets = ["кот", "пёс"]
pets[1] = "хомяк"
print(pets)`,explain:`Второй элемент заменён, и в списке теперь кот и хомяк.`}],faq:[],transfer_question:{example:`scores = [7, 8, 9]
scores[1] = 0
print(scores)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши список так, как его показывает Python.`,match_mode:`code`,options:[],help_option:null,accept:[`[7, 0, 9]`],misconceptions:[{id:`wrong_position`,match:[`[0, 8, 9]`],hint:`Номер 1 — это второй элемент: нумерация идёт с нуля.`,followup:`Какой по счёту элемент стоит под номером 1?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P6`}}],practice:[{id:`P1`,ladder_step:1,mode:`independent`,concepts:[`C1`],prompt:`В заготовке есть список животных. Выведи на экран второй элемент.`,starter_code:`animals = ["кот", "пёс", "хомяк"]`,expected:[],tests:[{inputs:[],output:[`пёс`],call:null}],must_use:[`index`],max_lines:3,hint:`Второй элемент имеет номер 1, потому что нумерация начинается с нуля.`,example:`colors = ["красный", "синий"]
print(colors[0])`},{id:`P2`,ladder_step:2,mode:`guided`,concepts:[`C2`],prompt:`Создай список nums с числами 1, 2, 3. Добавь в него число 4 методом append и выведи длину списка.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`4`],call:null}],must_use:[`list`,`methods`],max_lines:4,hint:`Три шага: создать список, вызвать nums.append(4), вывести len(nums).`,example:`a = [5]
a.append(6)
print(len(a))`},{id:`P3`,ladder_step:3,mode:`guided`,concepts:[`C3`,`C4`],prompt:`Заготовка хранит цены товаров. Выведи на экран сумму цен, используя цикл for.`,starter_code:`prices = [120, 80, 50, 250]`,expected:[],tests:[{inputs:[],output:[`500`],call:null}],must_use:[`for`],max_lines:6,hint:`Заведи total = 0, в цикле прибавляй каждый элемент, а print напиши после цикла.`,example:`s = 0
for x in [1, 2, 3]:
    s += x
print(s)`},{id:`P4`,ladder_step:4,mode:`guided`,concepts:[`C4`],prompt:`В заготовке есть список температур. Выведи, на сколько самая высокая температура больше самой низкой.`,starter_code:`temps = [18, 25, 21, 30, 15]`,expected:[],tests:[{inputs:[],output:[`15`],call:null}],must_use:[`builtins`],max_lines:3,hint:`Вычти min(temps) из max(temps) внутри print.`,example:`a = [3, 9]
print(max(a) - min(a))`},{id:`P5`,ladder_step:5,mode:`independent`,concepts:[`C3`],prompt:`В заготовке есть список имён. Для каждого имени выведи приветствие в таком виде: Привет, Аня!`,starter_code:`names = ["Аня", "Боря", "Вика"]`,expected:[],tests:[{inputs:[],output:[`Привет, Аня!`,`Привет, Боря!`,`Привет, Вика!`],call:null}],must_use:[`for`],max_lines:4,hint:`Цикл for name in names: и внутри с отступом print(f"Привет, {name}!").`,example:`items = ["чай", "кофе"]
for item in items:
    print(f"Заказ: {item}")`},{id:`P6`,ladder_step:6,mode:`independent`,concepts:[`C5`],prompt:`В заготовке есть список оценок. Замени первую оценку на 10 и выведи весь список.`,starter_code:`scores = [3, 5, 4]`,expected:[],tests:[{inputs:[],output:[`[10, 5, 4]`],call:null}],must_use:[`index`],max_lines:3,hint:`Первый элемент имеет номер 0: scores[0] = ... Потом print(scores).`,example:`a = [1, 2]
a[1] = 7
print(a)`},{id:`P7`,ladder_step:7,mode:`independent`,concepts:[`C2`,`C3`],prompt:`Прочитай три целых числа (каждое вводится отдельно), собери их в список и выведи сумму.`,starter_code:null,expected:[],tests:[{inputs:[`1`,`2`,`3`],output:[`6`],call:null},{inputs:[`10`,`20`,`5`],output:[`35`],call:null}],must_use:[`list`,`for`],max_lines:5,hint:`Создай пустой список nums = [], в цикле range(3) добавляй int(input()), а в конце выведи sum(nums).`,example:null}],project:{id:`MP7`,title:`Журнал оценок`,intro:`Построим электронный журнал: программа соберёт три оценки, посчитает среднюю, найдёт лучшую и худшую и скажет, сколько было пятёрок.`,max_lines:14,steps:[{id:`M1`,kind:`code`,prompt:`Создай пустой список marks. Пустой список записывается двумя квадратными скобками без элементов.`,requires:[`C1`],adds:[],tests:[{inputs:[],output:[`0`],call:`print(len(marks))`}],must_use:[],inputs:[],hint:`marks = [] — скобки открываются и сразу закрываются.`},{id:`M2`,kind:`code`,prompt:`Три раза прочитай оценку (целое число) и добавь её в marks.`,requires:[`C2`],adds:[],tests:[{inputs:[`4`,`5`,`3`],output:[`[4, 5, 3]`],call:`print(marks)`}],must_use:[`for`],inputs:[],hint:`Цикл for i in range(3): и внутри marks.append(int(input(...))).`},{id:`M3`,kind:`code`,prompt:`Выведи среднюю оценку: сумму оценок, делённую на их количество.`,requires:[`C4`],adds:[],tests:[{inputs:[`4`,`5`,`3`],output:[`4.0`],call:null},{inputs:[`5`,`5`,`5`],output:[`5.0`],call:null}],must_use:[`builtins`,`arith2`],inputs:[],hint:`sum(marks) делим знаком / на len(marks).`},{id:`M4`,kind:`code`,prompt:`Выведи ещё две строки: Лучшая: 5 и Худшая: 3 (с настоящими значениями).`,requires:[`C4`],adds:[],tests:[{inputs:[`4`,`5`,`3`],output:[`4.0`,`Лучшая: 5`,`Худшая: 3`],call:null},{inputs:[`2`,`2`,`5`],output:[`3.0`,`Лучшая: 5`,`Худшая: 2`],call:null}],must_use:[],inputs:[],hint:`Две f-строки: f"Лучшая: {max(marks)}" и такая же для min.`},{id:`M5`,kind:`code`,prompt:`Выведи последней строкой, сколько пятёрок получено, в виде Пятёрок: 1. Для подсчёта пройди циклом по marks.`,requires:[`C3`],adds:[],tests:[{inputs:[`4`,`5`,`3`],output:[`4.0`,`Лучшая: 5`,`Худшая: 3`,`Пятёрок: 1`],call:null},{inputs:[`5`,`5`,`5`],output:[`5.0`,`Лучшая: 5`,`Худшая: 5`,`Пятёрок: 3`],call:null},{inputs:[`2`,`3`,`4`],output:[`3.0`,`Лучшая: 4`,`Худшая: 2`,`Пятёрок: 0`],call:null}],must_use:[`for`,`if`],inputs:[],hint:`Заведи fives = 0, в цикле for m in marks: проверяй if m == 5: и увеличивай счётчик.`},{id:`M6`,kind:`predict_output`,prompt:`Допустим, ввели оценки 5, 5 и 2. Напиши, что программа покажет на экране. Каждая строка — с новой строки.`,requires:[`C4`],adds:[],tests:[],must_use:[],inputs:[`5`,`5`,`2`],hint:`Посчитай сумму и раздели её на три, потом найди наибольшую и наименьшую оценки и посчитай пятёрки.`}],outro:`Готово: в журнале есть средняя, лучшая и худшая оценки, и подсчёт пятёрок. Списки и циклы вместе дают огромные возможности для обработки данных.`},assignment:{id:`T7`,title:`Статистика продаж за неделю`,level:`Сложное`,summary:`Читает продажи за пять дней и считает сумму, среднее, лучший день и дни выше среднего.`,brief:`Заказчик: небольшой магазин. Нужна сводка по продажам за пять рабочих дней. Программа пять раз спрашивает сумму продаж за день (целое число) и выводит статистику.

Пример. Ввод: 10, 20, 30, 40, 50. Вывод:
Всего: 150
Среднее: 30.0
Лучший день: 5
Дней выше среднего: 2`,requirements:[`Собери введённые числа в список`,`Всего — сумма продаж (sum)`,`Среднее — сумма, делённая на количество дней (результат с точкой)`,`Лучший день — номер дня (от 1) с наибольшими продажами; если таких несколько, берётся первый (метод index)`,`Дней выше среднего — сколько дней продажи были строго больше среднего (цикл for и if)`],plan:[`Создай пустой список и пять раз добавь в него число из input.`,`Всего считай sum(список), среднее делением на len(список).`,`Номер лучшего дня: список.index(max(список)) + 1.`,`Дни выше среднего посчитай счётчиком в цикле for с условием if.`],warmup:{prompt:`Создай список из чисел 4, 8 и 15 и выведи сумму его элементов.`,tests:[{inputs:[],output:[`27`],call:null}],must_use:[`list`],max_lines:4,hint:`numbers = [4, 8, 15], а сумму даёт sum(numbers).`},tests:[{inputs:[`10`,`20`,`30`,`40`,`50`],output:[`Всего: 150`,`Среднее: 30.0`,`Лучший день: 5`,`Дней выше среднего: 2`],call:null},{inputs:[`5`,`5`,`5`,`5`,`5`],output:[`Всего: 25`,`Среднее: 5.0`,`Лучший день: 1`,`Дней выше среднего: 0`],call:null},{inputs:[`12`,`7`,`30`,`7`,`1`],output:[`Всего: 57`,`Среднее: 11.4`,`Лучший день: 3`,`Дней выше среднего: 2`],call:null},{inputs:[`0`,`0`,`9`,`0`,`0`],output:[`Всего: 9`,`Среднее: 1.8`,`Лучший день: 3`,`Дней выше среднего: 1`],call:null}],must_use:[`list`,`for`,`if`,`builtins`,`methods`],max_lines:18,hint:`Список наполняй циклом с append. Номер лучшего дня даёт sales.index(max(sales)) + 1. Дни выше среднего считай счётчиком в цикле.`},code_feedback:{syntax_error:`Python не смог прочитать эту строку. Чаще всего не хватает кавычки или скобки — проверь, что у каждой открывающей есть закрывающая.`,too_many_lines:`Здесь нужно меньше строк. Оставь только то, о чём просит задание.`,not_learned_yet:`В коде есть то, что мы ещё не проходили. Попробуй решить задание тем, что уже знаешь.`,missing_assignment:`Не вижу строки, где значение сохраняется в нужную переменную.`,wrong_variable_name:`Имя переменной отличается от того, что в задании. Проверь, как оно пишется.`,missing_quotes:`Без кавычек Python считает слово именем другой переменной и ищет её. Текст нужно взять в кавычки.`,empty_text:`Между кавычками пусто. Напиши текст внутри них.`,string_instead_of_number:`Число в кавычках Python считает текстом. Здесь нужно именно число, поэтому кавычки не нужны.`,number_instead_of_string:`Здесь нужен текст, поэтому значение пишется в кавычках.`,number_out_of_range:`Число выглядит необычно для этого задания. Проверь его ещё раз.`,missing_print:`Значение сохранено, но на экран оно не выводится. Для этого нужен print.`,printed_literal_instead_of_variable:`В скобках print стоит текст в кавычках, поэтому на экран выведется само это слово. Чтобы вывести значение переменной, напиши её имя без кавычек.`,unchanged_starter:`Строка пока осталась такой же, как была. Измени её по заданию.`,wrong_output:`Программа работает, но результат не тот, что нужен. Сравни, что ожидалось и что получилось.`,runtime_error:`Программа остановилась с ошибкой. Прочитай, что случилось, и исправь это место.`,too_slow:`Программа не закончила работу. Скорее всего, цикл никогда не останавливается.`,missing_construct:`Задание нужно решить с помощью темы урока. Посмотри, что именно требуется.`,empty_code:`Поле пустое. Напиши программу по заданию и нажми «Проверить».`}},{id:`L8`,version:1,title:`Функции`,welcome:`Урок 8, последний. Ты уже умеешь хранить данные, считать, спрашивать, выбирать и повторять. Остаётся научиться упаковывать код в функции: один раз написал, много раз использовал. Так устроены все большие программы.`,features:[`def`,`return`,`call`],phrases:{greeting:`Привет! Я твой преподаватель программирования. Учиться будем маленькими шагами: я объясняю одну мысль, показываю короткий пример и задаю один вопрос. Если что-то непонятно — просто напиши об этом, это нормальная часть обучения.`,correct:[`Верно.`,`Да, правильно.`,`Точно.`],correct_after_help:`Верно. Закрепим на новом примере.`,clarify:`Я не совсем понял сообщение. Это ответ на вопрос или мне объяснить по-другому?`,off_topic:`Давай вернёмся к уроку — так ты быстрее дойдёшь до своей первой программы.`,return_to_question:`Вернёмся к вопросу:`,not_learned_yet:`Хороший вопрос, но для этого нужны темы, которых мы ещё не проходили. Мы дойдём до них в следующих уроках.`,dont_know:`Ничего страшного, разберём вместе.`,assessment_help:`Это проверочный вопрос, поэтому ответ я не подскажу. Напомню главное:`,why_fallback:`Хороший вопрос. Чтобы не сбиться, давай сначала закончим этот шаг, а потом вернёмся к нему.`,practice_intro:`Теперь попробуй написать код сам. Пиши прямо в поле в сообщении. Кнопка «Запустить» покажет, что выведет программа, а «Проверить» отправит решение на проверку.`,practice_correct:`Код правильный.`,project_paused:`Для этого шага пригодится тема, которую стоит повторить. Повторим её и сразу вернёмся к проекту.`,project_resumed:`Возвращаемся к проекту.`,concept_mastered:`Тема освоена:`,lesson_complete:`Урок пройден. Ты знаешь все основные кирпичики программирования на Python.`,how_to_use:`Как это работает. Я объясняю, а ты отвечаешь: нажимай на кнопки с ответами или пиши своими словами в строке внизу. Если что-то непонятно, нажми «Объясни проще», и я объясню по-другому. Ошибаться можно, так и учатся.`,transfer_intro:`Теперь тот же вопрос на новом примере.`,try_again:`Попробуй ещё раз.`,concepts_done:`Все темы урока разобраны. Теперь потренируемся писать код самому.`,practice_retry:`Исправь код и отправь снова.`,hint_no_open:`Сейчас у меня нет открытого вопроса. Можно задать вопрос по теме или нажать «Повтори».`,next_lessons:`Этот урок уже пройден. Любой урок можно повторить: открой «Мой путь» на главном экране.`,review_intro:`Вернёмся к теме «{title}». Сначала напомню главное.`,predict_reveal:`Вот что будет на экране:`,reteach_intro:`Объясню по-другому.`,assignment_intro:`Это тестовое задание. Прочитай условие и требования, а план решения подскажет, с чего начать. Принятое решение попадёт в твоё портфолио.`,warmup_intro:`Впереди тестовое задание, как на собеседовании или от заказчика. Сначала разминка: маленькая задача на ту же тему, чтобы войти в ритм. Подсказка доступна всегда.`,warmup_done:`Разминка пройдена. Теперь само задание.`},concepts:[{id:`C1`,key:`def_and_call`,title:`Создание и вызов функции`,goal:`Ученик понимает, что def описывает функцию, а выполняется она при вызове.`,explain:`Функция — это именованный кусок кода, который можно запускать много раз. Её создают словом def: потом имя, скобки и двоеточие, а тело пишут с отступом. Сама по себе функция ничего не делает. Она работает только тогда, когда её вызывают по имени со скобками.`,example:`def hello():
    print("Привет")

hello()
hello()`,question:{kind:`gating`,format:`choice`,meaning:`Сколько раз слово Привет появится на экране?`,match_mode:`text`,options:[`0`,`1`,`2`,`Не знаю`],help_option:`Не знаю`,accept:[`2`,`два`],misconceptions:[{id:`def_runs_itself`,match:[`1`],hint:`Строка с def только описывает функцию, она её не запускает. Запускают функцию строки с вызовом, где имя и скобки.`,followup:`Сколько раз в программе стоит вызов hello()?`},{id:`never_runs`,match:[`0`],hint:`Ниже описания функции есть строки с вызовом. Каждый такой вызов выполняет тело функции.`,followup:`Сколько в программе строк с вызовом hello()?`}],from_example:!1,vocabulary:!1},reteach:`def — это как написать рецепт. Рецепт лежит в книге и ничего не готовит. Блюдо появляется только тогда, когда ты говоришь: «приготовь по рецепту». Это и есть вызов функции.`,walkthrough:`Строка с def записывает рецепт, ничего не выводя. Потом hello() вызывает функцию, и выводится Привет. Вторая строка hello() вызывает её снова. Всего слово появится 2 раза.`,alt_examples:[{code:`def cheer():
    print("Ура!")

cheer()`,explain:`Описание функции ничего не выводит. Одна строка с вызовом cheer() выведет Ура! один раз.`}],faq:[{keywords:[`зачем функци`,`зачем нужны`],answer:`Функция позволяет не копировать один и тот же код. Исправил в одном месте — работает везде, где её вызываешь.`}],transfer_question:{example:`def cheer():
    print("Ура")

cheer()
cheer()
cheer()`,question:{kind:`gating`,format:`input`,meaning:`Сколько раз слово Ура появится на экране? Ответь числом.`,match_mode:`text`,options:[],help_option:null,accept:[`3`,`три`],misconceptions:[{id:`def_runs_itself`,match:[`1`,`один`,`0`],hint:`Описание функции ничего не выводит. Выводит каждый её вызов.`,followup:`Сколько в программе строк с вызовом cheer()?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`independent`],after_error:[`transfer`],independent_task:`P1`}},{id:`C2`,key:`parameters`,title:`Параметры`,goal:`Ученик понимает, что значение из вызова попадает в параметр функции.`,explain:`Функции можно передавать данные. Имена параметров пишут в скобках после имени функции. При вызове в скобках пишут значения, и они попадают в параметры. Так одна функция работает с разными данными.`,example:`def greet(name):
    print(f"Привет, {name}!")

greet("Аня")`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране? Напиши точно так, как будет выглядеть.`,match_mode:`code`,options:[],help_option:null,accept:[`Привет, Аня!`],misconceptions:[{id:`parameter_name_printed`,match:[`Привет, name!`],hint:`name — это имя параметра. При вызове в него попадает значение из скобок.`,followup:`Какое значение написано в скобках при вызове функции?`}],from_example:!0,vocabulary:!1},reteach:`Параметр — это пустая ячейка внутри функции. Когда функцию вызывают, в ячейку кладут значение из скобок вызова. Дальше функция работает с этим значением.`,walkthrough:`Вызов greet("Аня") кладёт значение Аня в параметр name. Внутри функции f-строка подставляет его вместо {name}. На экране: Привет, Аня!`,alt_examples:[{code:`def shout(word):
    print(word.upper())

shout("эй")`,explain:`Значение из скобок попадает в параметр word, и функция выводит его заглавными буквами.`}],faq:[],transfer_question:{example:`def square(n):
    print(n * n)

square(4)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`16`,`шестнадцать`],misconceptions:[{id:`parameter_name_printed`,match:[`n * n`],hint:`Параметр n принимает значение из скобок вызова. Функция сначала считает, а потом выводит.`,followup:`Какое число стоит в скобках при вызове?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P2`}},{id:`C3`,key:`return_value`,title:`return: результат функции`,goal:`Ученик понимает, что return отдаёт значение туда, откуда функцию вызвали.`,explain:`Функция может вернуть результат — значение, которое можно сохранить в переменную или вывести. Для этого есть слово return. Оно завершает функцию и отдаёт значение туда, где функцию вызвали.`,example:`def double(x):
    return x * 2

result = double(5)
print(result)`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`10`,`десять`],misconceptions:[{id:`argument_printed`,match:[`5`,`пять`],hint:`Функция не выводит то, что ей передали, а возвращает результат вычисления.`,followup:`Что именно возвращает функция: какое выражение стоит после return?`}],from_example:!0,vocabulary:!1},reteach:`return — это как ответ на вопрос. Ты спрашиваешь функцию «чему равно удвоенное число?», она считает и отвечает. Ответ можно положить в переменную.`,walkthrough:`Вызов double(5) передаёт 5 в x. Функция считает x * 2 и возвращает 10. Это значение попадает в result, и print показывает 10.`,alt_examples:[{code:`def add(a, b):
    return a + b

print(add(1, 2))`,explain:`Функция возвращает сумму двух параметров, а print показывает то, что вернулось.`}],faq:[],transfer_question:{example:`def add(a, b):
    return a + b

print(add(3, 4))`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`7`,`семь`],misconceptions:[{id:`first_argument`,match:[`3`,`три`],hint:`Функция возвращает сумму обоих параметров, а не только первый.`,followup:`Какие два значения стоят в скобках при вызове?`}],from_example:!0,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P3`}},{id:`C4`,key:`print_vs_return`,title:`print и return — разные вещи`,goal:`Ученик понимает, что print только показывает, а return отдаёт значение; функция без return возвращает None.`,explain:`print и return часто путают. print показывает значение на экране, но функция при этом ничего не отдаёт. return отдаёт значение вызвавшему коду. Если в функции нет return, то результатом вызова будет особое значение None, «ничего».`,example:`def f(x):
    print(x * 2)

result = f(5)
print(result)`,question:{kind:`gating`,format:`input`,meaning:`Функция уже вывела свой результат при вызове. Что покажет последняя строка, print(result)?`,match_mode:`text`,options:[],help_option:null,accept:[`None`],misconceptions:[{id:`print_means_return`,match:[`10`,`5`],hint:`Число функция только показала на экране через print. Вернуть его без return она не могла.`,followup:`Есть ли в функции строка с return?`}],from_example:!1,vocabulary:!0},reteach:`print — это как сказать ответ вслух: его услышали, но никто его не записал. return — это записать ответ на бумажку и отдать. Переменная может сохранить только то, что отдали.`,walkthrough:`При вызове f(5) функция выводит 10 через print. Но return в ней нет, поэтому вызов возвращает None, и в result попадает None. Последняя строка показывает None.`,alt_examples:[{code:`def f(x):
    return x * 2

result = f(5)
print(result)`,explain:`Здесь return отдаёт значение, и оно сохраняется в result. Вывод появляется только от последней строки.`}],faq:[{keywords:[`none`,`ничего`,`нан`],answer:`None — особое значение «ничего нет». Его получают, когда функция не вернула результат.`}],transfer_question:{example:`def g(x):
    print(x + 1)

value = g(3)
print(value)`,question:{kind:`gating`,format:`input`,meaning:`Функция уже вывела свой результат при вызове. Что покажет последняя строка, print(value)?`,match_mode:`text`,options:[],help_option:null,accept:[`None`],misconceptions:[{id:`print_means_return`,match:[`4`,`3`],hint:`Число функция только показала на экране. В value она его не отдала, потому что return нет.`,followup:`Что возвращает функция без return?`}],from_example:!1,vocabulary:!0}},evidence_policy:{require:[`structured_check`,`non_choice`,`transfer`],after_error:[`transfer`],independent_task:null}},{id:`C5`,key:`return_in_if`,title:`return внутри условия`,goal:`Ученик понимает, что return сразу завершает функцию.`,explain:`return можно писать внутри if. Как только Python доходит до return, функция заканчивается, и остальные строки уже не выполняются. Поэтому часто пишут: если условие верно, вернуть один ответ; иначе вернуть другой.`,example:`def sign(n):
    if n > 0:
        return "плюс"
    return "не плюс"

print(sign(3))
print(sign(-1))`,question:{kind:`gating`,format:`input`,meaning:`Что покажет вторая строка, print(sign(-1))?`,match_mode:`text`,options:[],help_option:null,accept:[`не плюс`],misconceptions:[{id:`ignored_condition`,match:[`плюс`],hint:`Сначала проверь условие в функции для переданного числа. Если оно неверно, return внутри if пропускается.`,followup:`Верно ли, что отрицательное число больше нуля?`}],from_example:!1,vocabulary:!1},reteach:`Функция читает строки сверху вниз. Если условие верно, она встречает return и сразу отдаёт ответ. Если неверно, она пропускает return внутри if и идёт дальше, к следующему return.`,walkthrough:`Для -1 условие n > 0 неверно, поэтому return внутри if пропускается. Python идёт дальше и встречает второй return, который отдаёт текст «не плюс».`,alt_examples:[{code:`def check(n):
    if n > 10:
        return "много"
    return "мало"

print(check(50))`,explain:`Условие верно, поэтому сразу срабатывает первый return, и вернётся слово «много».`}],faq:[],transfer_question:{example:`def grade(p):
    if p >= 50:
        return "сдал"
    return "не сдал"

print(grade(30))`,question:{kind:`gating`,format:`input`,meaning:`Что появится на экране?`,match_mode:`text`,options:[],help_option:null,accept:[`не сдал`],misconceptions:[{id:`ignored_condition`,match:[`сдал`],hint:`Проверь условие для переданного числа. Если оно неверно, первый return пропускается.`,followup:`Верно ли, что 30 не меньше второго числа в условии?`}],from_example:!1,vocabulary:!1}},evidence_policy:{require:[`structured_check`,`non_choice`,`independent`],after_error:[`transfer`],independent_task:`P4`}}],practice:[{id:`P1`,ladder_step:1,mode:`guided`,concepts:[`C1`],prompt:`Создай функцию hello(), которая выводит Привет, мир! и вызови её два раза.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`Привет, мир!`,`Привет, мир!`],call:null}],must_use:[`def`,`call`],max_lines:5,hint:`Сначала def hello(): с отступом и print внутри, потом отдельно две строки hello() без отступа.`,example:`def hi():
    print("Хай")

hi()`},{id:`P2`,ladder_step:2,mode:`independent`,concepts:[`C2`],prompt:`Напиши функцию area(w, h), которая выводит площадь прямоугольника (ширина, умноженная на высоту). Вызывать её самому не нужно, программа проверит функцию сама.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`6`],call:`area(2, 3)`},{inputs:[],output:[`20`],call:`area(5, 4)`}],must_use:[`def`],max_lines:4,hint:`Параметры w и h пишутся в скобках после имени. Внутри — print(w * h).`,example:`def add(a, b):
    print(a + b)`},{id:`P3`,ladder_step:3,mode:`independent`,concepts:[`C3`,`C4`],prompt:`Напиши функцию double(x), которая возвращает (return, а не print) число, удвоенное x. Вызывать её самому не нужно.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`8`],call:`print(double(4))`},{inputs:[],output:[`20`],call:`print(double(10))`}],must_use:[`def`,`return`],max_lines:4,hint:`Внутри функции используй return x * 2, а не print.`,example:`def inc(n):
    return n + 1`},{id:`P4`,ladder_step:4,mode:`independent`,concepts:[`C5`],prompt:`Напиши функцию grade(points). Если баллов 90 и больше, она возвращает Отлично, если 70 и больше — Хорошо, иначе — Надо повторить.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`Отлично`],call:`print(grade(95))`},{inputs:[],output:[`Хорошо`],call:`print(grade(70))`},{inputs:[],output:[`Надо повторить`],call:`print(grade(30))`}],must_use:[`def`,`return`,`if`],max_lines:8,hint:`Проверяй условия сверху вниз. После каждого условия — return с нужным словом, а в конце общий return.`,example:`def size(n):
    if n > 100:
        return "большой"
    return "маленький"`},{id:`P5`,ladder_step:5,mode:`independent`,concepts:[`C3`,`C5`],prompt:`Напиши функцию count_even(nums), которая принимает список чисел и возвращает, сколько в нём чётных чисел.`,starter_code:null,expected:[],tests:[{inputs:[],output:[`2`],call:`print(count_even([1, 2, 3, 4]))`},{inputs:[],output:[`0`],call:`print(count_even([1, 3]))`},{inputs:[],output:[`3`],call:`print(count_even([2, 4, 6]))`}],must_use:[`def`,`return`,`for`],max_lines:8,hint:`Заведи счётчик count = 0, пройди циклом по nums, увеличивай счётчик для чётных, а в конце верни его.`,example:null}],project:{id:`MP8`,title:`Итоговый проект: журнал на функциях`,intro:`Итоговый проект. Соберём журнал оценок из урока 7 заново, но теперь каждая задача будет отдельной функцией. Так работают настоящие программы: маленькие понятные части и короткая главная часть.`,max_lines:24,steps:[{id:`M1`,kind:`code`,prompt:`Напиши функцию read_marks(n): она n раз читает оценку (целое число), собирает оценки в список и возвращает его.`,requires:[`C3`],adds:[],tests:[{inputs:[`4`,`5`,`3`],output:[`[4, 5, 3]`],call:`print(read_marks(3))`}],must_use:[`def`,`return`],inputs:[],hint:`Создай пустой список, в цикле добавляй int(input(...)) и верни список через return.`},{id:`M2`,kind:`code`,prompt:`Добавь функцию average(marks): она возвращает среднюю оценку (сумма, делённая на количество).`,requires:[`C3`],adds:[],tests:[{inputs:[],output:[`4.0`],call:`print(average([4, 5, 3]))`},{inputs:[],output:[`2.5`],call:`print(average([2, 3]))`}],must_use:[],inputs:[],hint:`Внутри функции: return sum(marks) / len(marks).`},{id:`M3`,kind:`code`,prompt:`Добавь функцию count_fives(marks): она возвращает, сколько пятёрок в списке.`,requires:[`C5`],adds:[],tests:[{inputs:[],output:[`2`],call:`print(count_fives([5, 4, 5]))`},{inputs:[],output:[`0`],call:`print(count_fives([3, 4]))`}],must_use:[],inputs:[],hint:`Заведи счётчик, пройди по оценкам и увеличивай его, когда оценка равна пяти.`},{id:`M4`,kind:`code`,prompt:`Напиши главную часть: прочитай три оценки через read_marks(3) и выведи три строки: среднюю, лучшую (Лучшая: 5) и число пятёрок (Пятёрок: 1).`,requires:[`C3`],adds:[],tests:[{inputs:[`4`,`5`,`3`],output:[`4.0`,`Лучшая: 5`,`Пятёрок: 1`],call:null},{inputs:[`5`,`5`,`2`],output:[`4.0`,`Лучшая: 5`,`Пятёрок: 2`],call:null}],must_use:[],inputs:[],hint:`Сохрани результат read_marks(3) в переменную, а потом вызови остальные функции с ней.`},{id:`M5`,kind:`predict_output`,prompt:`Допустим, ввели оценки 5, 5 и 2. Напиши, что программа покажет на экране. Каждая строка — с новой строки.`,requires:[`C3`],adds:[],tests:[],must_use:[],inputs:[`5`,`5`,`2`],hint:`Среднюю посчитай как сумму, делённую на три. Результат деления выводится с точкой.`}],outro:`Готово: итоговый проект собран из отдельных функций. Ты прошёл весь путь от первой переменной до программы, которую можно показывать.`},assignment:{id:`T8`,title:`Набор утилит: fizzbuzz, простые числа, гласные`,level:`Сложное`,summary:`Три небольшие функции с понятными контрактами: fizzbuzz, проверка числа на простоту и подсчёт гласных.`,brief:`Заказчик: команда, которая проверяет начинающих разработчиков. Нужен небольшой модуль из трёх функций. Вызывать их самому не нужно: проверка вызовет каждую функцию с разными данными.

1) fizzbuzz(n) возвращает строку: «FizzBuzz», если n делится на 15; «Fizz», если делится на 3; «Buzz», если делится на 5; иначе само число, превращённое в строку.
2) is_prime(n) возвращает True, если n — простое число (больше 1 и делится только на 1 и на себя), иначе False.
3) count_vowels(text) возвращает количество русских гласных букв (а е ё и о у ы э ю я) в тексте, регистр не важен.

Примеры: fizzbuzz(9) → Fizz, is_prime(17) → True, count_vowels("Привет, мир") → 3.`,requirements:[`Три функции с именами fizzbuzz, is_prime и count_vowels`,`Функции возвращают значения (return), а не печатают их`,`is_prime(1) и is_prime(0) возвращают False`,`count_vowels не различает заглавные и строчные буквы`,`Не используй ничего, кроме того, что мы прошли`],plan:[`fizzbuzz: сначала проверь делимость на 15, потом на 3 и на 5, иначе верни число строкой.`,`is_prime: числа меньше 2 не простые, остальные проверь делителями в цикле.`,`count_vowels: приведи текст к нижнему регистру и проверь каждую букву оператором in.`,`Все три функции возвращают значения через return, а не печатают.`],warmup:{prompt:`Напиши функцию double(n), которая возвращает число n, умноженное на 2. Вызывать её самой не нужно: проверка вызовет функцию с разными числами.`,tests:[{inputs:[],output:[`8`],call:`print(double(4))`},{inputs:[],output:[`0`],call:`print(double(0))`},{inputs:[],output:[`-6`],call:`print(double(-3))`}],must_use:[`def`,`return`],max_lines:4,hint:`def double(n): и внутри return n * 2.`},tests:[{inputs:[],output:[`FizzBuzz`],call:`print(fizzbuzz(15))`},{inputs:[],output:[`Fizz`],call:`print(fizzbuzz(9))`},{inputs:[],output:[`Buzz`],call:`print(fizzbuzz(10))`},{inputs:[],output:[`7`],call:`print(fizzbuzz(7))`},{inputs:[],output:[`True`],call:`print(is_prime(2))`},{inputs:[],output:[`False`],call:`print(is_prime(1))`},{inputs:[],output:[`True`],call:`print(is_prime(17))`},{inputs:[],output:[`False`],call:`print(is_prime(21))`},{inputs:[],output:[`3`],call:`print(count_vowels("Привет, мир"))`},{inputs:[],output:[`1`],call:`print(count_vowels("ЙЦУКН"))`},{inputs:[],output:[`0`],call:`print(count_vowels(""))`}],must_use:[`def`,`return`],max_lines:30,hint:`fizzbuzz: проверяй сначала делимость на 15. is_prime: если n меньше 2, верни False, потом проверь делители циклом. count_vowels: приведи текст к нижнему регистру и проверяй каждую букву через in.`},code_feedback:{syntax_error:`Python не смог прочитать эту строку. Чаще всего не хватает кавычки или скобки — проверь, что у каждой открывающей есть закрывающая.`,too_many_lines:`Здесь нужно меньше строк. Оставь только то, о чём просит задание.`,not_learned_yet:`В коде есть то, что мы ещё не проходили. Попробуй решить задание тем, что уже знаешь.`,missing_assignment:`Не вижу строки, где значение сохраняется в нужную переменную.`,wrong_variable_name:`Имя переменной отличается от того, что в задании. Проверь, как оно пишется.`,missing_quotes:`Без кавычек Python считает слово именем другой переменной и ищет её. Текст нужно взять в кавычки.`,empty_text:`Между кавычками пусто. Напиши текст внутри них.`,string_instead_of_number:`Число в кавычках Python считает текстом. Здесь нужно именно число, поэтому кавычки не нужны.`,number_instead_of_string:`Здесь нужен текст, поэтому значение пишется в кавычках.`,number_out_of_range:`Число выглядит необычно для этого задания. Проверь его ещё раз.`,missing_print:`Значение сохранено, но на экран оно не выводится. Для этого нужен print.`,printed_literal_instead_of_variable:`В скобках print стоит текст в кавычках, поэтому на экран выведется само это слово. Чтобы вывести значение переменной, напиши её имя без кавычек.`,unchanged_starter:`Строка пока осталась такой же, как была. Измени её по заданию.`,wrong_output:`Программа работает, но результат не тот, что нужен. Сравни, что ожидалось и что получилось.`,runtime_error:`Программа остановилась с ошибкой. Прочитай, что случилось, и исправь это место.`,too_slow:`Программа не закончила работу. Скорее всего, цикл никогда не останавливается.`,missing_construct:`Задание нужно решить с помощью темы урока. Посмотри, что именно требуется.`,empty_code:`Поле пустое. Напиши программу по заданию и нажми «Проверить».`}}]};const l=/* #__PURE__ */ Object.assign({"../../../engine/dragon_engine/__init__.py":e,"../../../engine/dragon_engine/checker.py":t,"../../../engine/dragon_engine/controller.py":n,"../../../engine/dragon_engine/course.py":r,"../../../engine/dragon_engine/intents.py":i,"../../../engine/dragon_engine/interp.py":a,"../../../engine/dragon_engine/normalize.py":o,"../../../engine/dragon_engine/runner.py":s}),u=self;let d=null,f=null,p=null;async function m(e){let t=await fetch(e);if(!t.ok)throw Error(`Не удалось загрузить Python (${t.status})`);let n=atob((await t.text()).trim()),r=new Uint8Array(n.length);for(let e=0;e<n.length;e++)r[e]=n.charCodeAt(e);return URL.createObjectURL(new Blob([r],{type:`application/zip`}))}async function h(e){let t=await import(
/* @vite-ignore */
`${e}pyodide.mjs`),n=await m(`${e}python_stdlib.b64.txt`),r=await t.loadPyodide({indexURL:e,stdLibURL:n});r.FS.mkdirTree(`/engine/dragon_engine`);for(let[e,t]of Object.entries(l))r.FS.writeFile(`/engine/dragon_engine/${e.split(`/`).pop()}`,t);return r.FS.writeFile(`/engine/course.json`,JSON.stringify(c)),r.runPython(`
import sys, json
sys.path.insert(0, "/engine")
from dragon_engine import start_course_state, course_step, run_snippet
with open("/engine/course.json", encoding="utf-8") as f:
    COURSE = json.load(f)

def _start():
    return json.dumps(start_course_state(COURSE), ensure_ascii=False)

def _turn(state_json, event_json):
    res = course_step(COURSE, json.loads(state_json), json.loads(event_json))
    return json.dumps(res, ensure_ascii=False)

def _run(code, inputs_json):
    return json.dumps(run_snippet(code, json.loads(inputs_json)), ensure_ascii=False)
`),d=r.globals.get(`_turn`),f=r.globals.get(`_start`),p=r.globals.get(`_run`),{contentVersion:c.content_version,courseTitle:c.title,initialState:JSON.parse(f())}}u.onmessage=async e=>{let{id:t,kind:n,payload:r}=e.data;try{if(n===`init`)u.postMessage({id:t,ok:!0,result:await h(r.indexURL)});else if(n===`run`){if(!p)throw Error(`Ядро ещё не загружено`);u.postMessage({id:t,ok:!0,result:JSON.parse(p(r.code,JSON.stringify(r.inputs)))})}else{if(!d)throw Error(`Ядро ещё не загружено`);let e=d(JSON.stringify(r.state),JSON.stringify(r.event));u.postMessage({id:t,ok:!0,result:JSON.parse(e)})}}catch(e){u.postMessage({id:t,ok:!1,error:e instanceof Error?e.message:String(e)})}};