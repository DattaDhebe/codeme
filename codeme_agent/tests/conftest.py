"""Ordinary test runs must never start a real automatic model download."""

import pytest

from codeme_agent.config import settings


@pytest.fixture(autouse=True)
def disable_automatic_model_setup(monkeypatch):
    # Tests specifically covering startup can opt in after this fixture and mock
    # the worker. New lifespan tests remain offline by default, including when
    # contributors run bare pytest without exporting AUTO_MODEL_SETUP=false.
    monkeypatch.setattr(settings, "auto_model_setup", False)
