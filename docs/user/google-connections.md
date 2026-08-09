# Connect a Google account

Google accounts are connected from an automation step that reads Gmail or creates a Gmail draft.

1. Open an automation and select the email step.
2. Under **Email account**, choose **Connect Gmail account**.
3. Enter the Google account email address.
4. If this is the first Google account on the selected environment, upload a Desktop OAuth client
   JSON file from Google Cloud.
5. Open the Google authorization page and approve the requested access.
6. Google finishes at a local callback address. The page may not load; copy the complete address
   from the browser address bar, return to Command Center, and paste it into the setup window.
7. Choose **Finish connection**. The new account is selected for the step automatically.

The connection belongs to the current Space and the environment shown in the Automations header.
Connecting an account on one environment does not expose it to another environment.

To detach an account connected through the app, select it in an email step and choose **Remove
account from Space**. This removes the Space binding but does not revoke the underlying Google login,
which may still be used by another Space. Connections managed by private configuration must be
removed there instead.

Command Center requests Gmail read access. A draft step additionally requests permission to create
drafts. Sending mail remains blocked. OAuth client credentials and Google refresh tokens stay in the
selected environment's runtime credential storage; they are not written to an automation definition
or private configuration repository.

The selected environment must have the supported Google connector installed. If it is unavailable,
Command Center shows the required version in the setup window.
