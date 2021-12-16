import * as core from "@actions/core";
import * as github from "@actions/github";
import * as im from "@actions/exec/lib/interfaces"; // eslint-disable-line no-unused-vars
import * as tr from "@actions/exec/lib/toolrunner";
import * as io from "@actions/io";
import * as os from "os";
import * as path from "path";
import * as url from "url";
import fs from "fs";
import retry from "async-retry";
import * as dep from "./dependencies";

const validROS1Distros: string[] = ["kinetic", "lunar", "melodic", "noetic"];
const validROS2Distros: string[] = [
	"dashing",
	"eloquent",
	"foxy",
	"galactic",
	"rolling",
];
const targetROS1DistroInput: string = "target-ros1-distro";
const targetROS2DistroInput: string = "target-ros2-distro";
const isLinux: boolean = process.platform == "linux";
const isWindows: boolean = process.platform == "win32";

/**
 * Join string array using a single space and make sure to filter out empty elements.
 *
 * @param values the string values array
 * @returns the joined string
 */
export function filterNonEmptyJoin(values: string[]): string {
	return values.filter((v) => v.length > 0).join(" ");
}

/**
 * Check if a string is a valid JSON string.
 *
 * @param str the string to validate
 * @returns `true` if valid, `false` otherwise
 */
function isValidJson(str: string): boolean {
	try {
		JSON.parse(str);
	} catch (e) {
		return false;
	}
	return true;
}

/**
 * Convert local paths to URLs.
 *
 * The user can pass the VCS repo file either as a URL or a path.
 * If it is a path, this function will convert it into a URL (file://...).
 * If the file is already passed as an URL, this function does nothing.
 *
 * @param   vcsRepoFileUrl     path or URL to the repo file
 * @returns                    URL to the repo file
 */
function resolveVcsRepoFileUrl(vcsRepoFileUrl: string): string {
	if (fs.existsSync(vcsRepoFileUrl)) {
		return url.pathToFileURL(path.resolve(vcsRepoFileUrl)).href;
	} else {
		return vcsRepoFileUrl;
	}
}

/**
 * Execute a command in bash and wrap the output in a log group.
 *
 * @param   commandLine     command to execute (can include additional args). Must be correctly escaped.
 * @param   commandPrefix    optional string used to prefix the command to be executed.
 * @param   options         optional exec options.  See ExecOptions
 * @param   log_message     log group title.
 * @returns Promise<number> exit code
 */
export async function execBashCommand(
	commandLine: string,
	commandPrefix?: string,
	options?: im.ExecOptions,
	log_message?: string
): Promise<number> {
	commandPrefix = commandPrefix || "";
	const bashScript = `${commandPrefix}${commandLine}`;
	const message = log_message || `Invoking: bash -c '${bashScript}'`;

	let toolRunnerCommandLine = "";
	let toolRunnerCommandLineArgs: string[] = [];
	if (isWindows) {
		toolRunnerCommandLine = "C:\\Windows\\system32\\cmd.exe";
		// This passes the same flags to cmd.exe that "run:" in a workflow.
		// https://help.github.com/en/actions/automating-your-workflow-with-github-actions/workflow-syntax-for-github-actions#using-a-specific-shell
		// Except for /D, which disables the AutoRun functionality from command prompt
		// and it blocks Python virtual environment activation if one configures it in
		// the previous steps.
		toolRunnerCommandLineArgs = [
			"/E:ON",
			"/V:OFF",
			"/S",
			"/C",
			"call",
			"%programfiles(x86)%\\Microsoft Visual Studio\\2019\\Enterprise\\VC\\Auxiliary\\Build\\vcvarsall.bat",
			"amd64",
			"&",
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"-c",
			bashScript,
		];
	} else {
		toolRunnerCommandLine = "bash";
		toolRunnerCommandLineArgs = ["-c", bashScript];
	}
	const runner: tr.ToolRunner = new tr.ToolRunner(
		toolRunnerCommandLine,
		toolRunnerCommandLineArgs,
		options
	);
	if (options && options.silent) {
		return runner.exec();
	}
	return core.group(message, () => {
		return runner.exec();
	});
}

//Determine whether all inputs name supported ROS distributions.
export function validateDistros(
	ros1Distro: string,
	ros2Distro: string
): boolean {
	if (!ros1Distro && !ros2Distro) {
		core.setFailed(
			`Neither '${targetROS1DistroInput}' or '${targetROS2DistroInput}' inputs were set, at least one is required.`
		);
		return false;
	}
	if (ros1Distro && validROS1Distros.indexOf(ros1Distro) <= -1) {
		core.setFailed(
			`Input ${ros1Distro} was not a valid ROS 1 distribution for '${targetROS1DistroInput}'. Valid values: ${validROS1Distros}`
		);
		return false;
	}
	if (ros2Distro && validROS2Distros.indexOf(ros2Distro) <= -1) {
		core.setFailed(
			`Input ${ros2Distro} was not a valid ROS 2 distribution for '${targetROS2DistroInput}'. Valid values: ${validROS2Distros}`
		);
		return false;
	}
	return true;
}

/**
 * Install ROS dependencies for given packages in the workspace, for all ROS distros being used.
 */
async function installRosdeps(
	packageSelection: string,
	workspaceDir: string,
	options: im.ExecOptions,
	ros1Distro?: string,
	ros2Distro?: string
): Promise<number> {
	const scriptName = "install_rosdeps.sh";
	const scriptPath = path.join(workspaceDir, scriptName);
	const scriptContent = `#!/bin/bash
	set -euxo pipefail
	if [ $# != 1 ]; then
		echo "Specify rosdistro name as single argument to this script"
		exit 1
	fi
	DISTRO=$1
	package_paths=$(colcon list --paths-only ${packageSelection})
	# suppress errors from unresolved install keys to preserve backwards compatibility
	# due to difficulty reading names of some non-catkin dependencies in the ros2 core
	# see https://index.ros.org/doc/ros2/Installation/Foxy/Linux-Development-Setup/#install-dependencies-using-rosdep
	rosdep install -r --from-paths $package_paths --ignore-src --skip-keys rti-connext-dds-5.3.1 --rosdistro $DISTRO -y || true`;
	fs.writeFileSync(scriptPath, scriptContent, { mode: 0o766 });

	let exitCode = 0;
	if (ros1Distro) {
		exitCode += await execBashCommand(
			`./${scriptName} ${ros1Distro}`,
			"",
			options
		);
	}
	if (ros2Distro) {
		exitCode += await execBashCommand(
			`./${scriptName} ${ros2Distro}`,
			"",
			options
		);
	}
	return exitCode;
}

/**
 * Run tests and process & aggregate coverage results.
 *
 * @param colconCommandPrefix the prefix to use before colcon commands
 * @param options the exec options
 * @param testPackageSelection the package selection option string
 * @param extra_options the extra options for 'colcon test'
 * @param coverageIgnorePattern the coverage filter pattern to use for lcov, or an empty string
 */
async function runTests(
	colconCommandPrefix: string,
	options: im.ExecOptions,
	testPackageSelection: string,
	extra_options: string[],
	coverageIgnorePattern: string
): Promise<void> {
	// ignoreReturnCode is set to true to avoid having a lack of coverage
	// data fail the build.
	const colconLcovInitialCmd = "colcon lcov-result --initial";
	await execBashCommand(colconLcovInitialCmd, colconCommandPrefix, {
		...options,
		ignoreReturnCode: true,
	});

	const colconTestCmd = filterNonEmptyJoin([
		`colcon test`,
		`--event-handlers console_cohesion+`,
		`--return-code-on-test-failure`,
		testPackageSelection,
		`${extra_options.join(" ")}`,
	]);
	await execBashCommand(colconTestCmd, colconCommandPrefix, options);

	// ignoreReturnCode, check comment above in --initial
	const colconLcovResultCmd = filterNonEmptyJoin([
		`colcon lcov-result`,
		coverageIgnorePattern !== "" ? `--filter ${coverageIgnorePattern}` : "",
		testPackageSelection,
		`--verbose`,
	]);
	await execBashCommand(colconLcovResultCmd, colconCommandPrefix, {
		...options,
		ignoreReturnCode: true,
	});

	const colconCoveragepyResultCmd = filterNonEmptyJoin([
		`colcon coveragepy-result`,
		testPackageSelection,
		`--verbose`,
		`--coverage-report-args -m`,
	]);
	await execBashCommand(
		colconCoveragepyResultCmd,
		colconCommandPrefix,
		options
	);
}

async function run_throw(): Promise<void> {
    await execBashCommand(
        "rosdep update"
    );
    await execBashCommand(
        "rosdep install -iy --from-path src/ros2_controllers"
    );
    await execBashCommand(
        "source /opt/ros/galactic/setup.bash"
    );
    await execBashCommand(
        "colcon build --symlink-install"
    );
    // dummy comment to differentiate

async function run(): Promise<void> {
	try {
		await run_throw();
	} catch (error) {
		core.setFailed(error.message);
	}
}

run();
