"""Sample application module."""

import os
import os.path as osp
from collections import OrderedDict, defaultdict

MAX_RETRIES = 3
_internal_cache = {}


def fetch(url):
    """Fetch a URL with retries."""
    import json  # nested import

    return url


class Repository:
    """A repository of things."""

    default_branch = "main"

    def __init__(self, name):
        self.name = name

    def clone(self, dest):
        """Clone the repo to dest."""
        return fetch(self.name)

    def _private_helper(self):
        pass
