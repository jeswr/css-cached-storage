"""Bad fixture — should be flagged by ruff (N802 function name, N806 local, F401 unused)."""
import os


def BadFunction():
    UnusedLocal = 1
    return 2
