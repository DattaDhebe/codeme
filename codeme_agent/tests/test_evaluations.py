import json

import pytest

from codeme_agent import evaluations as ev
from scripts import evaluate_models as cli


class ScriptedClient:
    default_model = "fixture-coder:7b"

    def __init__(self, responses=(), models=None, capabilities=None):
        self.responses = iter(responses)
        self.requests = []
        self.models = models or [self.default_model]
        self.capabilities = capabilities if capabilities is not None else ["completion", "tools"]

    def list_models(self, timeout=5):
        return self.models

    def model_capabilities(self, model=None, timeout=5):
        return self.capabilities

    def chat_with_tools(self, messages, tools, model=None, timeout=180):
        self.requests.append({"messages": messages, "model": model, "timeout": timeout,
                              "tools": [item["function"]["name"] for item in tools]})
        result = next(self.responses)
        if isinstance(result, BaseException):
            raise result
        return result


def call(name, arguments, *, content=False):
    if content:
        return {"content": json.dumps({"name": name, "arguments": arguments})}
    return {"content": "", "tool_calls": [{"function": {"name": name, "arguments": arguments}}]}


def modify(path="math_utils.py", before="return a - b", after="return a + b"):
    return {"type": "modify", "path": path, "summary": "Fix operator", "edits": [{"old_text": before, "new_text": after}]}


def fix_responses(*, content=False, after="return a + b"):
    return [call("read_file", {"path": "math_utils.py"}, content=content),
            call("propose_change_set", {"summary": "Fix addition", "operations": [modify(after=after)]}, content=content)]


def evaluate(tmp_path, case_id, client):
    return ev.evaluate_case(ev.select_cases([case_id])[0], client, client.default_model,
                            work_directory=tmp_path, inference_label="test_fixture")


def test_correct_bugfix_requires_real_agent_read_and_approval_pause(tmp_path):
    result = evaluate(tmp_path, "exact_bugfix", ScriptedClient(fix_responses()))
    assert result["status"] == "passed", result
    assert result["outcome"] == "awaiting_approval"
    assert result["workspace_unchanged"] is True
    assert result["model_requests"] == 2
    assert result["native_tool_calls"] == 2 and result["content_tool_calls"] == 0
    assert result["model_plan_updates"] == 0  # Software emits a plan too; that is not a model action.
    assert result["project_commands_executed"] is False
    assert list(tmp_path.iterdir()) == []


def test_correctness_oracle_rejects_wrong_operator_even_with_valid_proposal(tmp_path):
    result = evaluate(tmp_path, "exact_bugfix", ScriptedClient(fix_responses(after="return a * b")))
    assert result["status"] == "failed"
    assert "Incorrect proposed source: math_utils.py" in result["failures"]
    assert result["workspace_unchanged"] is True


def test_content_tool_transport_is_measured_before_compatibility_parser(tmp_path):
    result = evaluate(tmp_path, "exact_bugfix", ScriptedClient(fix_responses(content=True)))
    assert result["status"] == "passed", result
    assert result["native_tool_calls"] == 0 and result["content_tool_calls"] == 2
    assert {request["format"] for request in result["request_metrics"]} == {"content_tools"}


def test_multi_file_oracle_requires_one_complete_change_set(tmp_path):
    reads = {"content": "", "tool_calls": [
        {"function": {"name": "read_file", "arguments": {"path": "arithmetic.py"}}},
        {"function": {"name": "read_file", "arguments": {"path": "difference.py"}}},
    ]}
    response = call("propose_change_set", {"summary": "Repair both functions", "operations": [
        modify("arithmetic.py"), modify("difference.py", "return a + b", "return a - b")
    ]})
    result = evaluate(tmp_path, "multi_file", ScriptedClient([reads, response]))
    assert result["status"] == "passed", result
    assert result["proposals"] == 1


def test_nested_file_creation_never_creates_the_proposed_parent_on_disk(tmp_path):
    result = evaluate(tmp_path, "nested_create", ScriptedClient([call("propose_change_set", {
        "summary": "Create greeting", "operations": [{"type": "create", "path": "generated/helpers/greeting.py",
            "summary": "Create greeting", "content": "def greeting():\n    return 'hello local'\n"}],
    })]))
    assert result["status"] == "passed", result
    assert result["workspace_unchanged"] is True and result["project_commands_executed"] is False


def test_source_inspection_requires_rate_and_source_evidence(tmp_path):
    client = ScriptedClient([call("read_file", {"path": "app/tax.py"}),
                             {"content": '{"source":"app/tax.py","rate":0.18}'}])
    assert evaluate(tmp_path, "source_inspection", client)["status"] == "passed"


def test_inspection_fixture_guidance_does_not_require_an_edit_proposal(tmp_path):
    client = ScriptedClient([call("read_file", {"path": "app/tax.py"}),
                            {"content": '{"source":"app/tax.py","rate":0.18}'}])
    result = evaluate(tmp_path, "source_inspection", client)
    assert result["status"] == "passed" and result["proposals"] == 0
    visible = json.dumps(client.requests[0]["messages"])
    assert "When edits are requested, propose one complete change set" in visible
    assert "Never run commands or apply edits. Propose one complete change set" not in visible
    assert all(not name.startswith("propose_") for request in client.requests for name in request["tools"])


def test_canonical_source_read_paths_accept_equivalent_dot_prefix(tmp_path):
    responses = fix_responses()
    responses[0] = call("read_file", {"path": "./math_utils.py"})
    result = evaluate(tmp_path, "exact_bugfix", ScriptedClient(responses))
    assert result["status"] == "passed", result
    assert result["observed_source_reads"] == ["math_utils.py"]


@pytest.mark.parametrize("start,end", [(999, 999), (1, 1)])
def test_inspection_oracle_rejects_reads_that_did_not_deliver_the_rate(tmp_path, start, end):
    client = ScriptedClient([call("read_file", {"path": "app/tax.py", "start_line": start, "end_line": end}),
                            {"content": '{"source":"app/tax.py","rate":0.18}'}])
    result = evaluate(tmp_path, "source_inspection", client)
    assert result["status"] == "failed"
    assert "Required source facts were not delivered to the model" in result["failures"]
    assert result["delivered_source_facts"] == []


def test_inspection_can_read_only_the_relevant_return_line(tmp_path):
    client = ScriptedClient([call("read_file", {"path": "./app/tax.py", "start_line": 2, "end_line": 2}),
                            {"content": '{"source":"app/tax.py","rate":0.18}'}])
    result = evaluate(tmp_path, "source_inspection", client)
    assert result["status"] == "passed", result
    assert result["delivered_source_facts"] == ["app/tax.py"]


def test_scoped_guidance_is_delivered_to_the_model(tmp_path):
    client = ScriptedClient([call("read_file", {"path": "src/config.py"}), call("propose_change_set", {
        "summary": "Use scoped version", "operations": [modify("src/config.py", "'old'", "'scoped-v2'")],
    })])
    result = evaluate(tmp_path, "scoped_guidance", client)
    assert result["status"] == "passed", result
    assert "scoped-v2" in json.dumps(client.requests[-1]["messages"])


def test_transient_read_fault_must_be_exercised_then_recovered(tmp_path):
    result = evaluate(tmp_path, "read_error_recovery", ScriptedClient([
        call("read_file", {"path": "math_utils.py"}), *fix_responses(),
    ]))
    assert result["status"] == "passed", result
    assert result["read_fault_exercised"] is True
    assert [tool["status"] for tool in result["tools"] if tool["name"] == "read_file"] == ["running", "error", "running", "complete"]


def test_unread_write_is_an_injected_control_not_fake_model_quality(tmp_path):
    result = evaluate(tmp_path, "unread_write_guard", ScriptedClient(fix_responses()))
    assert result["status"] == "passed", result
    assert result["kind"] == "policy_control"
    assert result["injected_assistant_calls"] == 1
    assert result["model_requests"] == 2
    assert result["native_tool_calls"] == 2  # The injected write must not be counted as native model output.
    assert result["tools"][1]["status"] == "error"


def test_pre_cancel_never_calls_the_model_or_proposes_an_action(tmp_path):
    client = ScriptedClient()
    result = evaluate(tmp_path, "cancel_before_inference", client)
    assert result["status"] == "passed", result
    assert result["outcome"] == "cancelled"
    assert result["model_requests"] == 0 and client.requests == [] and result["proposals"] == 0


def test_model_request_budget_is_bounded_without_changing_agent_globals(tmp_path):
    limits = ev.EvaluationLimits(max_requests=1, case_seconds=5, request_seconds=2, total_seconds=10)
    result = ev.evaluate_case(ev.CASES[0], ScriptedClient(fix_responses()), "fixture-coder:7b",
                             work_directory=tmp_path, limits=limits, inference_label="test_fixture")
    assert result["status"] == "failed"
    assert result["budget_reached"] is True and result["model_requests"] == 1
    assert result["request_metrics"][0]["format"] == "native_tools"


def test_transport_error_is_separate_from_a_wrong_model_answer(tmp_path):
    result = evaluate(tmp_path, "exact_bugfix", ScriptedClient([ev.OllamaError("Local inference timeout")]))
    assert result["status"] == "error"
    assert result["error_category"] == "model_client"
    assert result["request_metrics"][0]["error_type"] == "OllamaError"
    assert result["workspace_unchanged"] is True


def test_oracle_rejects_an_unrequested_extra_source_file(tmp_path):
    responses = fix_responses()
    responses[-1]["tool_calls"][0]["function"]["arguments"]["operations"].append({
        "type": "create", "path": "extra.py", "summary": "Unrequested", "content": "extra = 1\n",
    })
    result = evaluate(tmp_path, "exact_bugfix", ScriptedClient(responses))
    assert result["status"] == "failed"
    assert "Proposed paths do not exactly match the requested task" in result["failures"]


def test_model_matrix_scores_quality_separately_from_policy_controls(tmp_path):
    client = ScriptedClient([*fix_responses(), *fix_responses()], models=["one:7b", "two:7b"])
    report = ev.run_evaluations(client, ["one:7b", "two:7b"], provider="ollama", work_directory=tmp_path,
                               case_ids=["exact_bugfix", "cancel_before_inference"], inference_label="test_fixture")
    assert report["summary"]["evaluated_models"] == 2
    assert report["summary"]["quality_passed"] == report["summary"]["quality_total"] == 2
    assert report["summary"]["policy_controls_passed"] == 2
    assert report["inference"] == "test_fixture"


def test_missing_model_is_reported_without_download_or_inference(tmp_path):
    client = ScriptedClient()
    report = ev.run_evaluations(client, ["not-installed"], provider="ollama", work_directory=tmp_path)
    assert report["models"][0]["status"] == "not_installed"
    assert report["summary"]["evaluated_models"] == 0 and client.requests == []


def test_ollama_aliases_do_not_inflate_actual_model_coverage(tmp_path):
    client = ScriptedClient(fix_responses(), models=["fixture-coder:latest"])
    report = ev.run_evaluations(client, ["fixture-coder", "fixture-coder:latest"], provider="ollama",
        work_directory=tmp_path, case_ids=["exact_bugfix"], inference_label="test_fixture")
    assert len(client.requests) == 2 and len(report["models"]) == 1
    assert report["models"][0]["requested_aliases"] == ["fixture-coder", "fixture-coder:latest"]
    assert report["summary"]["requested_model_identifiers"] == 2
    assert report["summary"]["evaluated_models"] == report["summary"]["quality_total"] == 1


def test_chat_only_model_is_unsupported_without_fake_quality_passes(tmp_path):
    client = ScriptedClient(capabilities=["completion"])
    report = ev.run_evaluations(client, [client.default_model], provider="ollama", work_directory=tmp_path,
                               case_ids=["exact_bugfix", "cancel_before_inference"])
    assert report["summary"]["unsupported"] == 1
    assert report["summary"]["quality_passed"] == 0 and report["summary"]["policy_controls_passed"] == 1
    assert client.requests == []


def test_default_cli_lists_cases_without_contacting_a_model(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "OllamaClient", lambda **kwargs: pytest.fail("Listing cases is inference/network free"))
    assert cli.main([]) == 0
    assert "No inference performed" in capsys.readouterr().out


def test_case_selection_and_limits_fail_clearly():
    with pytest.raises(ValueError, match="Unknown cases"):
        ev.select_cases(["invented"])
    with pytest.raises(ValueError, match="max_requests"):
        ev.EvaluationLimits(max_requests=0)


def test_operator_cancel_persists_a_partial_report_and_stops_later_cases(tmp_path):
    snapshots = []
    report = ev.run_evaluations(ScriptedClient([KeyboardInterrupt()]), ["fixture-coder:7b"],
        provider="ollama", work_directory=tmp_path,
        case_ids=["exact_bugfix", "nested_create"], checkpoint=lambda value: snapshots.append(json.loads(json.dumps(value))))
    assert report["status"] == "cancelled"
    assert [case["status"] for case in report["models"][0]["cases"]] == ["cancelled", "skipped"]
    assert snapshots[-1]["summary"]["cancelled"] == 1


def test_report_has_no_raw_model_responses_or_private_reasoning(tmp_path):
    responses = fix_responses()
    responses[0]["content"] = "<think>hidden evaluation reasoning</think>"
    report = ev.run_evaluations(ScriptedClient(responses), ["fixture-coder:7b"], provider="ollama", work_directory=tmp_path,
        case_ids=["exact_bugfix"], inference_label="test_fixture")
    ev.write_report(report, tmp_path / "report.json")
    assert "hidden evaluation reasoning" not in (tmp_path / "report.json").read_text()


def test_noisy_repository_has_real_distractors_and_needs_an_exact_target_read(tmp_path):
    case = ev.select_cases(["noisy_repository"])[0]
    target = "services/shipping/rate_calculator.py"
    assert len(case.files) >= 130 and target not in case.prompt
    client = ScriptedClient([call("read_file", {"path": target}), call("propose_change_set", {
        "summary": "Include shipping", "operations": [modify(target, "return subtotal - shipping", "return subtotal + shipping")],
    })])
    result = evaluate(tmp_path, case.id, client)
    assert result["status"] == "passed", result
    assert result["proposed_source"][0]["path"] == target
    assert "subtotal + shipping" in result["proposed_source"][0]["public_content_excerpt"]


def test_total_deadline_clips_the_actual_transport_timeout(monkeypatch):
    monkeypatch.setattr(ev.time, "monotonic", lambda: 20.0)
    client = ScriptedClient([{"content": "public answer"}])
    observed = ev.ObservedClient(client, ev.CASES[0], ev.EvaluationLimits(), lambda: False, total_deadline=20.4)
    observed.chat_with_tools([], [], model=client.default_model)
    assert client.requests[0]["timeout"] == pytest.approx(.4)
    assert observed.calls[0]["public_response_excerpt"] == "public answer"


def test_report_provenance_fingerprints_fixture_inventory_and_loaded_code(tmp_path):
    report = ev.run_evaluations(ScriptedClient(fix_responses()), ["fixture-coder:7b"], provider="ollama",
        work_directory=tmp_path, case_ids=["exact_bugfix"], inference_label="test_fixture")
    provenance = report["provenance"]
    assert provenance["installed_model_inventory"] == ["fixture-coder:7b"]
    assert provenance["case_suite_version"] == ev.CASE_SUITE_VERSION
    assert len(provenance["case_definitions_sha256"]) == 64
    assert len(provenance["loaded_agent_run_code_sha256"]) == 64
    assert len(provenance["source_sha256_at_import"]["agent.py"]) == 64


def test_inference_configuration_records_actual_client_options_and_limits(monkeypatch):
    monkeypatch.setattr(ev.settings, "ollama_context_length", 16384)
    limits = ev.EvaluationLimits(max_requests=3, request_seconds=10, case_seconds=20, total_seconds=30)
    ollama = ev._inference_configuration(ev.OllamaClient(base_url="http://127.0.0.1:11434"), limits)
    compatible = ev._inference_configuration(ev.LocalCompatibleClient(base_url="http://127.0.0.1:1234/v1"), limits)
    assert ollama["agent_context_length"] == 16384
    assert ollama["client_generation_options"] == {"num_ctx": 16384}
    assert compatible["client_generation_options"] == {}
    assert ollama["temperature"] is None and "defaults are unknown" in ollama["sampling_note"]
    assert ollama["limits"] == {"max_requests": 3, "request_seconds": 10, "case_seconds": 20, "total_seconds": 30}


def test_public_diagnostics_remove_reasoning_from_text_responses_and_errors(tmp_path):
    client = ScriptedClient([{"content": "<think>private text</think>Cannot continue"},
        ev.OllamaError("<analysis>private error</analysis>Local failure")])
    result = evaluate(tmp_path, "exact_bugfix", client)
    serialized = json.dumps(result)
    assert "private text" not in serialized and "private error" not in serialized
    assert "Cannot continue" in serialized and "Local failure" in serialized


def test_full_source_oracle_rejects_extra_unrequested_functions(tmp_path):
    responses = fix_responses(after="return a + b\n\ndef unrelated():\n    return 1")
    result = evaluate(tmp_path, "exact_bugfix", ScriptedClient(responses))
    assert result["status"] == "failed"
    assert "Incorrect proposed source: math_utils.py" in result["failures"]


def test_source_oracle_rejects_deep_and_oversized_ast_without_executing_code(monkeypatch):
    assert not ev._same_source("value = " + "+".join(["1"] * 5000), "value = 1", "fixture.py")
    assert not ev._same_source("#" * (64 * 1024 + 1), "", "fixture.py")
    monkeypatch.setattr(ev.ast, "parse", lambda *args, **kwargs: (_ for _ in ()).throw(MemoryError()))
    assert not ev._same_source("value = 1", "value = 1", "fixture.py")


def test_unexpected_oracle_error_is_recorded_and_does_not_abort_matrix(tmp_path, monkeypatch):
    original = ev._grade
    count = 0
    def grade(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 1:
            raise RecursionError("oracle regression")
        return original(*args, **kwargs)
    monkeypatch.setattr(ev, "_grade", grade)
    report = ev.run_evaluations(ScriptedClient(fix_responses()), ["fixture-coder:7b"], provider="ollama",
        work_directory=tmp_path, case_ids=["exact_bugfix", "cancel_before_inference"], inference_label="test_fixture")
    assert [case["status"] for case in report["models"][0]["cases"]] == ["error", "passed"]
    assert report["models"][0]["cases"][0]["error_category"] == "oracle"
    assert "oracle failed safely" in report["models"][0]["cases"][0]["failures"][0]


def test_fixture_paths_cannot_escape_the_disposable_workspace(tmp_path):
    case = ev.EvaluationCase("unsafe", "unsafe", "Inspect", {"../escaped.py": "value = 1\n"})
    with pytest.raises(ValueError, match="safe workspace-relative"):
        ev.evaluate_case(case, ScriptedClient(), "fixture", work_directory=tmp_path)
    assert not (tmp_path.parent / "escaped.py").exists()


def test_checkpoint_replaces_complete_json_without_leaving_temporary_file(tmp_path):
    output = tmp_path / "report.json"
    ev.write_report({"status": "running"}, output)
    ev.write_report({"status": "complete"}, output)
    assert json.loads(output.read_text()) == {"status": "complete"}
    assert not output.with_name("report.json.tmp").exists()
