from __future__ import annotations

import os
import time

name = os.getenv("SERVICE_NAME", "indexer")
print(f"[{name}] placeholder started", flush=True)
while True:
    print(f"[{name}] heartbeat", flush=True)
    time.sleep(30)
