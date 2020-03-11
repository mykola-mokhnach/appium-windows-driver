import _ from 'lodash';
import url from 'url';
import { waitForCondition } from 'asyncbox';
import { util, fs, net, system } from 'appium-support';
import log from '../logger';
import { SubProcess } from 'teen_process';
import path from 'path';
import v8 from 'v8';
import B from 'bluebird';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';


const commands = {};

const RETRY_PAUSE = 300;
const RETRY_TIMEOUT = 5000;
const DEFAULT_TIME_LIMIT = 60 * 10; // 10 minutes
const PROCESS_SHUTDOWN_TIMEOUT = 10 * 1000;
const DEFAULT_EXT = 'mp4';
const FFMPEG_BINARY = `ffmpeg${system.isWindows() ? '.exe' : ''}`;
const DEFAULT_FPS = 15;


async function uploadRecordedMedia (localFile, remotePath = null, uploadOptions = {}) {
  const {size} = await fs.stat(localFile);
  log.debug(`The size of the resulting screen recording is ${util.toReadableSizeString(size)}`);
  if (_.isEmpty(remotePath)) {
    const maxMemoryLimit = v8.getHeapStatistics().total_available_size / 2;
    if (size >= maxMemoryLimit) {
      log.info(`The file might be too large to fit into the process memory ` +
        `(${util.toReadableSizeString(size)} >= ${util.toReadableSizeString(maxMemoryLimit)}). ` +
        `Provide a link to a remote writable location for video upload ` +
        `(http(s) and ftp protocols are supported) if you experience Out Of Memory errors`);
    }
    return (await fs.readFile(localFile)).toString('base64');
  }

  const remoteUrl = url.parse(remotePath);
  let options = {};
  const {user, pass, method} = uploadOptions;
  if (remoteUrl.protocol.startsWith('http')) {
    options = {
      url: remoteUrl.href,
      method: method || 'PUT',
      multipart: [{ body: fs.createReadStream(localFile) }],
    };
    if (user && pass) {
      options.auth = {user, pass};
    }
  } else if (remoteUrl.protocol.startsWith('ftp')) {
    options = {
      host: remoteUrl.hostname,
      port: remoteUrl.port || 21,
    };
    if (user && pass) {
      options.user = user;
      options.pass = pass;
    }
  }
  await net.uploadFile(localFile, remotePath, options);
  return '';
}

async function requireFfmpegPath () {
  try {
    return await fs.which(FFMPEG_BINARY);
  } catch (e) {
    log.errorAndThrow(`${FFMPEG_BINARY} has not been found in PATH. ` +
      `Please make sure it is installed`);
  }
}

class ScreenRecorder {
  constructor (videoPath, opts = {}) {
    this._videoPath = videoPath;
    this._process = null;
    this._fps = opts.fps || DEFAULT_FPS;
    this._videoFilter = opts.videoFilter;
    this._timeLimit = opts.timeLimit || DEFAULT_TIME_LIMIT;
  }

  async getVideoPath () {
    return (await fs.exists(this._videoPath)) ? this._videoPath : '';
  }

  isRunning () {
    return !!(this._process?.isRunning);
  }

  async start () {
    const ffmpeg = await requireFfmpegPath();

    const args = [
      '-loglevel', 'error',
      '-t', `${this._timeLimit}`,
      '-f', 'gdigrab',
      '-framerate', `${this._fps}`,
      '-i', 'desktop',
      '-vcodec', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-movflags', '+faststart',
      '-fflags', 'nobuffer',
      '-f', DEFAULT_EXT,
      '-r', `${this._fps}`,
    ];
    if (this._videoFilter) {
      args.push('-filter:v', this._videoFilter);
    }

    const fullCmd = [
      ffmpeg,
      ...args,
      this.dstVideoPath,
    ];

    this._process = new SubProcess(fullCmd[0], fullCmd.slice(1));
    log.debug(`Starting ${FFMPEG_BINARY}: ${fullCmd.join(' ')}`);
    this.process.on('output', (stdout, stderr) => {
      log.debug(`[${FFMPEG_BINARY}] ${stdout || stderr}`);
    });
    await this._process.start(0);
    try {
      await waitForCondition(async () => !!(await this.getVideoPath()), {
        waitMs: RETRY_TIMEOUT,
        intervalMs: RETRY_PAUSE,
      });
    } catch (e) {
      try {
        if (this.isRunning()) {
          await this._process.stop('SIGKILL');
        }
      } catch (ign) {
      } finally {
        this._process = null;
      }
      log.errorAndThrow(`The expected screen record file '${this._videoPath}' does not exist after ${RETRY_TIMEOUT}ms. ` +
        `Is ${FFMPEG_BINARY} available and operational?`);
    }
    log.info(`The video recording has started. Will timeout in ${util.pluralize('second', this._timeLimit, true)}`);
  }

  async stop (force = false) {
    const cleanupCorruptedVideo = async () => {
      const videoPath = await this.getVideoPath();
      if (videoPath) {
        await fs.unlink(videoPath);
      }
    };

    if (force) {
      if (this.isRunning()) {
        await this._process.stop('SIGKILL');
      }
      this._process = null;
      await cleanupCorruptedVideo();
      return null;
    }

    if (!this.isRunning()) {
      log.debug('Screen recording is not running. Returning the recent result');
      return await this.getVideoPath();
    }

    return new B((resolve, reject) => {
      this._process.once('exit', async (code) => {
        this._process = null;
        if (code === 0) {
          log.debug('Screen recording has exited without errors');
          resolve(await this.getVideoPath());
        } else {
          reject(new Error(`${FFMPEG_BINARY} exited with error code ${code}`));
        }
      });

      this._process.proc.stdin.write('q');
      this._process.proc.stdin.end();
      setTimeout(async () => {
        await this._process.stop('SIGKILL');
        await cleanupCorruptedVideo();
        reject(new Error(`${FFMPEG_BINARY} has failed to exit after ${PROCESS_SHUTDOWN_TIMEOUT}ms`));
      }, PROCESS_SHUTDOWN_TIMEOUT);
    });
  }
}


/**
 * @typedef {Object} StartRecordingOptions
 *
 * @property {?string} videoFilter - The video filter spec to apply for ffmpeg.
 * See https://trac.ffmpeg.org/wiki/FilteringGuide for more details on the possible values.
 * Example: Set it to `scale=ifnot(gte(iw\,1024)\,iw\,1024):-2` in order to limit the video width
 * to 1024px. The height will be adjusted automatically to match the actual ratio.
 * @property {number|string} fps [15] - The count of frames per second in the resulting video.
 * The greater fps it has the bigger file size is.
 * @property {string|number} timeLimit [600] - The maximum recording time, in seconds. The default value is 10 minutes.
 * @property {boolean} forceRestart [true] - Whether to ignore the call if a screen recording is currently running
 * (`false`) or to start a new recording immediately and terminate the existing one if running (`true`).
 */

/**
 * Record the display of a real devices running Android 4.4 (API level 19) and higher.
 * Emulators are supported since API level 27 (Android P).
 * It records screen activity to an MPEG-4 file. Audio is not recorded with the video file.
 * If screen recording has been already started then the command will stop it forcefully and start a new one.
 * The previously recorded video file will be deleted.
 *
 * @param {?StartRecordingOptions} options - The available options.
 * @returns {string} Base64-encoded content of the recorded media file if
 *                   any screen recording is currently running or an empty string.
 * @throws {Error} If screen recording has failed to start or is not supported on the device under test.
 */
commands.startRecordingScreen = async function startRecordingScreen (options = {}) {
  const {
    timeLimit,
    videoFilter,
    fps,
    forceRestart = true,
  } = options;
  if (this._screenRecorder) {
    if (this._screenRecorder.isRunning()) {
      log.debug('The screen recording is already running');
      if (!forceRestart) {
        log.debug('Doing nothing');
        return;
      }
      log.debug('Forcing the active screen recording to stop');
      await this._screenRecorder.stop(true);
    }
    this._screenRecorder = null;
  }

  const videoPath = path.resolve(os.tmpdir(), `${uuidv4().substring(0, 8)}.${DEFAULT_EXT}`);
  this._screenRecorder = new ScreenRecorder(videoPath, {
    fps: parseInt(fps, 10),
    timeLimit: parseInt(timeLimit, 10),
    videoFilter,
  });
  try {
    await this._screenRecorder.start();
  } catch (e) {
    this._screenRecorder = null;
    throw e;
  }
};

/**
 * @typedef {Object} StopRecordingOptions
 *
 * @property {?string} remotePath - The path to the remote location, where the resulting video should be uploaded.
 *                                  The following protocols are supported: http/https, ftp.
 *                                  Null or empty string value (the default setting) means the content of resulting
 *                                  file should be encoded as Base64 and passed as the endpount response value.
 *                                  An exception will be thrown if the generated media file is too big to
 *                                  fit into the available process memory.
 * @property {?string} user - The name of the user for the remote authentication.
 * @property {?string} pass - The password for the remote authentication.
 * @property {?string} method - The http multipart upload method name. The 'PUT' one is used by default.
 */

/**
 * Stop recording the screen.
 * If no screen recording has been started before then the method returns an empty string.
 *
 * @param {?StopRecordingOptions} options - The available options.
 * @returns {string} Base64-encoded content of the recorded media file if 'remotePath'
 *                   parameter is falsy or an empty string.
 * @throws {Error} If there was an error while getting the name of a media file
 *                 or the file content cannot be uploaded to the remote location
 *                 or screen recording is not supported on the device under test.
 */
commands.stopRecordingScreen = async function stopRecordingScreen (options = {}) {
  if (!this._screenRecorder) {
    log.debug('No screen recording has been started. Doing nothing');
    return '';
  }

  const {
    remotePath,
    user,
    pass,
    method
  } = options;
  log.debug('Retrieving the resulting video data');
  const videoPath = await this._screenRecorder.stop();
  if (!videoPath) {
    log.debug('No video data is found. Returning an empty string');
    return '';
  }
  return await uploadRecordedMedia(videoPath, remotePath, {
    user, pass, method,
  });
};

export default commands;
