const pMap = require("p-map");

import progressBar        from "./progress-bar";
import RemoteRepo         from "./remote-repo";
import * as Configuration from "./configuration";
import findPullRequestId  from "./find-pull-request-id";
import * as Git from "./git";

const UNRELEASED_TAG = "___unreleased___";
const COMMIT_FIX_REGEX = /(fix|close|resolve)(e?s|e?d)? [T#](\d+)/i;

interface CommitInfo {
  number?: number;
  title?: string;
  pull_request?: {
    html_url: string;
  },
  commitSHA: string;
  message: string;
  labels: any[];
  tags?: string[];
  date: string;
  user?: any;
}

interface TagInfo {
  date: string;
  commits: CommitInfo[];
}

interface CategoryInfo {
  heading: string | undefined;
  commits: CommitInfo[];
}

export default class Changelog {
  config: any;
  remote: RemoteRepo;
  tagFrom?: string;
  tagTo?: string;

  constructor(options: any = {}) {
    this.config = this.getConfig();
    this.remote = new RemoteRepo(this.config);

    // CLI options
    this.tagFrom = options["tag-from"];
    this.tagTo = options["tag-to"];
  }

  getConfig() {
    return Configuration.fromGitRoot(process.cwd());
  }

  async createMarkdown() {
    let markdown = "\n";

    // Get all info about commits in a certain tags range
    const commitsInfo = await this.getCommitInfos();

    // Step 4: Group commits by tag (local)
    const commitsByTag = await this.getCommitsByTag(commitsInfo);

    for (const tag of Object.keys(commitsByTag)) {
      const commitsForTag = commitsByTag[tag].commits;

      // Step 5: Group commits in release by category (local)
      const commitsByCategory = this.getCommitsByCategory(commitsForTag);

      // Step 6: Compile list of committers in release (local + remote)
      const committers = await this.getCommitters(commitsForTag);

      // Skip this iteration if there are no commits available for the tag
      const hasCommitsForCurrentTag = commitsByCategory.some(
        (category) => category.commits.length > 0
      );
      if (!hasCommitsForCurrentTag) continue;

      const releaseTitle = tag === UNRELEASED_TAG ? "Unreleased" : tag;
      markdown += `## ${releaseTitle} (${commitsByTag[tag].date})`;

      progressBar.init(commitsByCategory.length);

      const categoriesWithCommits = commitsByCategory
        .filter((category) => category.commits.length > 0);

      for (const category of categoriesWithCommits) {
        progressBar.tick(category.heading || "Other");

        // Step 7: Group commits in category by package (local)
        const commitsByPackage: { [id: string]: CommitInfo[] } = category.commits.reduce((acc: { [id: string]: CommitInfo[] }, commit) => {
          // Array of unique packages.
          const changedPackages = this.getListOfUniquePackages(commit.commitSHA);

          const heading = changedPackages.length > 0
            ? `* ${changedPackages.map((pkg) => `\`${pkg}\``).join(", ")}`
            : "* Other";

          acc[heading] = acc[heading] || [];
          acc[heading].push(commit);

          return acc;
        }, {});

        markdown += "\n";
        markdown += "\n";
        markdown += `#### ${category.heading}`;

        const headings = Object.keys(commitsByPackage);
        const onlyOtherHeading = headings.length === 1 && headings[0] === "* Other";

        // Step 8: Print commits
        for (const heading of headings) {
          const commits = commitsByPackage[heading];

          if (!onlyOtherHeading) {
            markdown += `\n${heading}`;
          }

          for (const commit of commits) {
            markdown += onlyOtherHeading ? "\n* " : "\n  * ";

            if (commit.number && commit.pull_request && commit.pull_request.html_url) {
              const prUrl = commit.pull_request.html_url;
              markdown += `[#${commit.number}](${prUrl}) `;
            }

            if (commit.title && commit.title.match(COMMIT_FIX_REGEX)) {
              commit.title = commit.title.replace(
                COMMIT_FIX_REGEX,
                `Closes [#$3](${this.remote.getBaseIssueUrl()}$3)`
              );
            }

            markdown += `${commit.title}. ([@${commit.user.login}](${commit.user.html_url}))`;
          }
        }
      }

      progressBar.terminate();

      markdown += `\n\n#### Committers: ${committers.length}\n`;
      markdown += committers.map((commiter) => `- ${commiter}`).join("\n");
      markdown += "\n\n\n";
    }

    return markdown.substring(0, markdown.length - 3);
  }

  getListOfUniquePackages(sha: string): string[] {
    return Git.changedPaths(sha)
      .map((path: string) => path.indexOf("packages/") === 0 ? path.slice(9).split("/", 1)[0] : "")
      .filter(Boolean)
      .filter(onlyUnique);
  }

  async getListOfTags(): Promise<string[]> {
    return Git.listTagNames();
  }

  async getLastTag() {
    return Git.lastTag();
  }

  async getListOfCommits(): Promise<Git.CommitListItem[]> {
    // Determine the tags range to get the commits for. Custom from/to can be
    // provided via command-line options.
    // Default is "from last tag".
    const tagFrom = this.tagFrom || (await this.getLastTag());
    return Git.listCommits(tagFrom, this.tagTo);
  }

  async getCommitters(commits: CommitInfo[]): Promise<string[]> {
    const committers: { [id: string]: string } = {};

    for (const commit of commits) {
      const login = (commit.user || {}).login;
      // If a list of `ignoreCommitters` is provided in the lerna.json config
      // check if the current committer should be kept or not.
      const shouldKeepCommiter = login && (
        !this.config.ignoreCommitters ||
        !this.config.ignoreCommitters.some(
          (c: string) => c === login || login.indexOf(c) > -1
        )
      );
      if (login && shouldKeepCommiter && !committers[login]) {
        const user = await this.remote.getUserData(login);
        const userNameAndLink = `[${login}](${user.html_url})`;
        if (user.name) {
          committers[login] = `${user.name} (${userNameAndLink})`;
        } else {
          committers[login] = userNameAndLink;
        }
      }
    }

    return Object.keys(committers).map((k) => committers[k]).sort();
  }

  async getCommitInfos(): Promise<CommitInfo[]> {
    // Step 1: Get list of commits between tag A and B (local)
    const commits = await this.getListOfCommits();
    const allTags = await this.getListOfTags();

    progressBar.init(commits.length);

    const commitInfos = await pMap(commits, async (commit: Git.CommitListItem) => {
      const { sha, refName, summary: message, date } = commit;

      // Step 2: Find tagged commits (local)
      let tagsInCommit;
      if (refName.length > 1) {
        // Since there might be multiple tags referenced by the same commit,
        // we need to treat all of them as a list.
        tagsInCommit = allTags.filter(tag => refName.indexOf(tag) !== -1);
      }

      progressBar.tick(sha);

      let commitInfo: CommitInfo = {
        commitSHA: sha,
        message: message,
        // Note: Only merge commits or commits referencing an issue / PR
        // will be kept in the changelog.
        labels: [],
        tags: tagsInCommit,
        date
      };

      // Step 3: Download PR data (remote)
      const issueNumber = findPullRequestId(message);
      if (issueNumber !== null) {
        const response = await this.remote.getIssueData(issueNumber);
        commitInfo = {
          ...commitInfo,
          ...response,
          commitSHA: sha,
          mergeMessage: message,
        };
      }

      return commitInfo;
    }, { concurrency: 5 });

    progressBar.terminate();
    return commitInfos;
  }

  async getCommitsByTag(commits: CommitInfo[]): Promise<{ [id: string]: TagInfo }> {
    // Analyze the commits and group them by tag.
    // This is useful to generate multiple release logs in case there are
    // multiple release tags.
    let currentTags = [UNRELEASED_TAG];
    return commits.reduce((acc: any, commit) => {
      if (commit.tags && commit.tags.length > 0) {
        currentTags = commit.tags;
      }

      // Tags referenced by commits are treated as a list. When grouping them,
      // we split the commits referenced by multiple tags in their own group.
      // This results in having one group of commits for each tag, even if
      // the same commits are "duplicated" across the different tags
      // referencing them.
      const commitsForTags: any = {};
      for (const currentTag of currentTags) {
        let existingCommitsForTag = [];
        if ({}.hasOwnProperty.call(acc, currentTag)) {
          existingCommitsForTag = acc[currentTag].commits;
        }

        let releaseDate = this.getToday();
        if (currentTag !== UNRELEASED_TAG) {
          releaseDate = acc[currentTag] ? acc[currentTag].date : commit.date;
        }

        commitsForTags[currentTag] = {
          date: releaseDate,
          commits: existingCommitsForTag.concat(commit)
        };
      }

      return {
        ...acc,
        ...commitsForTags,
      };
    }, {});
  }

  getCommitsByCategory(allCommits: CommitInfo[]): CategoryInfo[] {
    const { labels } = this.config;

    return Object.keys(labels).map((label) => {
      let heading = labels[label];

      // Keep only the commits that have a matching label with the one
      // provided in the lerna.json config.
      let commits = allCommits
        .filter((commit) => commit.labels.some((l: any) => l.name.toLowerCase() === label.toLowerCase()));

      return { heading, commits };
    });
  }

  getToday() {
    const date = new Date().toISOString();
    return date.slice(0, date.indexOf("T"));
  }
}

function onlyUnique(value: any, index: number, self: any[]): boolean {
  return self.indexOf(value) === index;
}
