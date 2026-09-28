# Restarting with pending work

When the server restarts, Command Center can retry an interactive request that was accepted but never sent to a provider. The retry uses the same message, attachments and selected model. Recovery is limited to two attempts per message across server restarts.

A request that may already have reached a provider is not automatically replayed. Check its transcript and any effects before retrying it yourself. A Stop remains effective across automatic recovery attempts. Archived or deleted threads and requests awaiting approval or user input are not automatically resumed.

This recovery applies to interactive requests. Work linked to a Command Center Run, and work already running when the server stopped, requires separate recovery and is not automatically replayed by this mechanism.
