from __future__ import annotations

from importlib.metadata import version
import logging

from rich.logging import RichHandler

FORMAT = "%(message)s"
logging.basicConfig(
    format=FORMAT, datefmt="[%X] ", handlers=[RichHandler()], level=logging.INFO,
)

from . import ai
from . import cli
from . import clustering
from . import games
from . import poker
from . import terminal
from . import utils

__version__ = version("rivermind-poker")
