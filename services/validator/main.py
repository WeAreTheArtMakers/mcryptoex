from __future__ import annotations

import os
import time

name = os.getenv("SERVICE_NAME", "validator")
print(f"[{name}] placeholder started", flush=True)
while True:
    print(f"[{name}] heartbeat", flush=True)
    time.sleep(30)
