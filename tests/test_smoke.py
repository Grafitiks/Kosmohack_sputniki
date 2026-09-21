from pathlib import Path

from model.operations import Session, replay_episode
from model.resource_env import load

ROOT = Path(__file__).resolve().parents[1]


def test_load_all_scenarios():
    for name in ("P01_intro", "P02_shift", "P03_energy", "P04_demand"):
        s = load(ROOT / "data" / f"{name}.json")
        assert s["meta"]["id"] == name


def test_idle_run_and_replay():
    s = load(ROOT / "data" / "P01_intro.json")
    session = Session(s, run_metadata={"goal": "priority", "algorithm": "idle", "version": "0", "parameters": {}})
    for _ in range(s["time"]["steps"]):
        session.advance({})
    res = session.result()
    assert res["steps_executed"] == 48
    replayed = replay_episode(res["initial_scenario"], res["events"], res["commands"], res["steps_executed"])
    assert replayed.summary() == session.summary()
