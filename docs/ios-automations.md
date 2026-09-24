# Native iOS automations

AutomationStore persists account-scoped definitions and durable event admissions atomically. AutomationCoordinator connects time, Core Location and App Intents triggers to the local runner or authenticated MultiVibe Cloud API. automation_manage exposes capabilities, CRUD, pause/resume and manual runs to Foundation Models, downloaded models and the remote Pi responder.

Local schedules use BGAppRefresh and foreground catch-up: iOS decides actual background execution times. Local notifications do not execute tasks. Geofences require Always location authorization and are limited to 20 regions. Downloaded Metal inference waits for the foreground; Apple Foundation inference can run within the system background budget. Active user conversations take priority.

Raccourcis can call SendMultiVibeAutomationEventIntent with a stable event identifier. Duplicate deliveries are coalesced. Cloud geofence events remain queued until connectivity returns. Cloud tasks require the server migration and explicit feature enablement; results sync on connection, with no APNs result delivery in this version.

Local execution exposes date/math and explicitly authorized HTTPS hosts, without private documents or arbitrary device actions. Cloud currently exposes date and reasoning over supplied event data. Each executor has bounded inference and cancellation. Interrupted runs are recorded rather than automatically replayed. Account switching cancels execution and removes the prior account's geofences.

Pi is pinned through native/ios/AgentHarness. Rebuild the bundle using that package's locked dependencies when updating, retain third-party notices, and verify the native harness tests. The Cloud runtime carries an independently hashed copy with Core and upstream notices; it does not alter the Cloud distribution's pinned Core image.

Validation covers persistence rollback, event deduplication, revision cancellation, timezone/DST behavior, tool exposure, upstream Pi transport, database replica admission, and the native list/detail UI. Physical geofence transitions require an actual location test; scheduling cannot guarantee execution while iOS restricts the app.
