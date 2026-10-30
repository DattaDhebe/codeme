"""Run with CodeMe's venv Python. Listing cases never starts inference."""

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from codeme_agent.config import settings
from codeme_agent.evaluations import CASES, EvaluationLimits, run_evaluations, select_cases, write_report
from codeme_agent.local_models import LocalCompatibleClient
from codeme_agent.ollama import OllamaClient, OllamaError


def main(argv=None):
    parser = argparse.ArgumentParser(description="Evaluate installed local models against disposable CodeMe tasks; never apply, execute, or download.")
    parser.add_argument("--run", action="store_true", help="Explicitly permit local model inference.")
    parser.add_argument("--list-models", action="store_true", help="Read the configured local daemon's installed inventory without inference.")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--model", action="append", help="Installed model ID; repeat for a matrix. Defaults to the configured model.")
    selection.add_argument("--all-installed", action="store_true", help="Evaluate every installed model; this can load large weights into memory.")
    parser.add_argument("--provider", choices=["ollama", "openai_compatible"], default=settings.model_provider)
    parser.add_argument("--endpoint", help="Override with a validated loopback URL for the selected protocol.")
    parser.add_argument("--case", action="append", dest="cases", help="Case ID; repeat to select a subset.")
    parser.add_argument("--max-requests", type=int, default=6)
    parser.add_argument("--case-seconds", type=float, default=240)
    parser.add_argument("--request-seconds", type=float, default=180)
    parser.add_argument("--total-seconds", type=float, default=1800)
    parser.add_argument("--output", type=Path, default=ROOT / ".runtime/evaluations/report.json")
    args = parser.parse_args(argv)
    try:
        cases = select_cases(args.cases)
        limits = EvaluationLimits(args.max_requests, args.case_seconds, args.request_seconds, args.total_seconds)
        if not args.run and not args.list_models:
            for case in cases:
                print(f"{case.id:26} {case.kind:16} {case.description}")
            print("\nNo inference performed. Add --run --model INSTALLED_ID to evaluate, or --list-models to inspect the local inventory.")
            return 0
        client = (OllamaClient(base_url=args.endpoint) if args.provider == "ollama"
                  else LocalCompatibleClient(base_url=args.endpoint))
        if args.list_models and not args.run:
            print("\n".join(client.list_models()) or "No installed local models found.")
            return 0
        models = client.list_models() if args.all_installed else args.model or [settings.default_model]
        if not models:
            raise OllamaError("No local models are installed; evaluation does not download models.")
        report = run_evaluations(client, models, provider=args.provider,
            work_directory=args.output.parent / "workspaces", case_ids=args.cases, limits=limits,
            progress=lambda message: print(message, flush=True), checkpoint=lambda report: write_report(report, args.output))
        write_report(report, args.output)
        summary = report["summary"]
        print(f"\nQuality {summary['quality_passed']}/{summary['quality_total']} ({summary['quality_evaluated']} attempted); recovery {summary['recovery_passed']}/{summary['recovery_total']}; controls {summary['policy_controls_passed']}/{summary['policy_controls_total']}; failed {summary['failed']}; request/case errors {summary['error']}; model errors {summary['model_errors']}; unsupported {summary['unsupported']}; skipped {summary['skipped']}.")
        print("Report: " + str(args.output.resolve()))
        if report["status"] == "cancelled":
            return 130
        return 1 if summary["failed"] or summary["error"] or summary["unsupported"] or summary["skipped"] or any(record["status"] != "evaluated" for record in report["models"]) else 0
    except (OllamaError, OSError, ValueError) as exc:
        if args.run:
            write_report({"schema_version": 1, "status": "error", "provider": args.provider,
                "inference": "live_local", "error": str(exc)[:600], "models": [],
                "summary": {"evaluated_models": 0, "error": 1},
                "execution_policy": "proposal_only_no_approvals_no_commands_no_downloads"}, args.output)
        print("Evaluation needs attention: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
