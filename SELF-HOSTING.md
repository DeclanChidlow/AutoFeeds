# Self-Hosting

If you are hosting your own instance, or wish to run a modified version of the bot, you can self-host it.

> [!IMPORTANT]
> Due to limited time and resources, I can _not_ offer free self-hosting support. If you’d like paid assistance, or to have AutoFeeds hosted on your behalf in a paid capacity, please [contact Vale](https://vale.rocks/contact).

> [!IMPORTANT]
> This is a technical guide intended for people who wish to setup their own Revolt instance.
> It is _not_ for the average end user. If you wish to add AutoFeeds to your server, you can [invite it]().

## Prerequisites

Ensure you have the following:

- [Git](https://git-scm.com)
- [Docker](https://www.docker.com)
- A capable server

## Installation

1.  **Clone the AutoFeeds repository** \
    `git clone https://github.com/DeclanChidlow/AutoFeeds`

2.  **Enter the AutoFeeds directory** \
    `cd AutoFeeds`

3.  **Setup configurations** \
    Copy the example configuration files to create the actual configuration files: \
    `cp compose.yml.example compose.yml` \
    `cp .env.example .env`

    You will need to edit `.env` to populate it with the relevant details. While the default `compose.yml` will work out of the box in most situations, you might need to tweak it depending on your specific configuration.

4.  **Build AutoFeeds** \
    `docker compose build`

5.  **Run it with Docker** \
    Start AutoFeeds with `docker compose up` and consult the logs. Assuming it runs without issues and nothing seems amiss, you can stop it, and restart it to run in the background (detached mode) with `docker compose up -d`.

## Updating

1. **Ensure you are in the AutoFeeds directory** \
   `cd AutoFeeds`

2. **Stop AutoFeeds** \
   `docker compose stop`

3. **Pull the latest changes** \
   This will copy the latest changes from GitHub to your local machine. \
   `git pull`

4. **Build AutoFeeds** \
   `docker compose build`

5. **Start AutoFeeds** \
   Start AutoFeeds with `docker compose up` and consult the logs. Assuming it runs without issues and nothing seems amiss, you can stop it, and restart it to run in the background (detached mode) with `docker compose up -d`.
