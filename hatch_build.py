"""Bundle the built viewer (viewer/dist) into wheels, so `mbv preview` works without the source tree.

Release builds ship a prebuilt viewer. Installing straight from git builds it here, which needs Node.js.
"""

import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if version == "editable":
            return  # source checkouts build and serve viewer/dist directly
        viewer = Path(self.root) / "viewer"
        dist = viewer / "dist"
        if not (dist / "index.html").exists():
            if not (viewer / "package.json").exists() or not shutil.which("npm"):
                raise RuntimeError(
                    "the viewer isn't built and Node.js isn't available to build it (viewer/dist missing)"
                )
            self.app.display_info("building the viewer (npm ci && npm run build) ...")
            subprocess.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=viewer, check=True)
            subprocess.run(["npm", "run", "build"], cwd=viewer, check=True)
        build_data["force_include"][str(dist)] = "mailbox_viewer/viewer"
