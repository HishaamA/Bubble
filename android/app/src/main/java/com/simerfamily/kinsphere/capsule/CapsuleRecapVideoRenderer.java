package com.simerfamily.kinsphere.capsule;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES20;
import android.opengl.GLUtils;
import android.view.Surface;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.List;

/** Encodes ordered still images as a deterministic portrait H.264 MP4. */
final class CapsuleRecapVideoRenderer {

    private static final long CODEC_TIMEOUT_MICROSECONDS = 10_000L;
    private static final long END_OF_STREAM_TIMEOUT_NANOSECONDS = 10_000_000_000L;

    /** Writes one complete MP4 or deletes the partial output after any failure. */
    void render(List<File> images, File output) throws IOException {
        if (
            images == null ||
            images.isEmpty() ||
            images.size() > CapsuleRecapContract.MAXIMUM_IMAGE_COUNT
        ) {
            throw new IOException("Add between one and 150 staged images to create a recap.");
        }
        if (output == null) {
            throw new IOException("The capsule recap output file is unavailable.");
        }

        MediaCodec encoder = null;
        MediaMuxer muxer = null;
        Surface codecSurface = null;
        CodecInputSurface inputSurface = null;
        TextureRenderer textureRenderer = null;
        Bitmap frame = null;
        boolean encoderStarted = false;
        boolean completed = false;
        MuxerState muxerState = new MuxerState();

        try {
            MediaFormat format = MediaFormat.createVideoFormat(
                MediaFormat.MIMETYPE_VIDEO_AVC,
                CapsuleRecapContract.WIDTH,
                CapsuleRecapContract.HEIGHT
            );
            format.setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
            );
            format.setInteger(MediaFormat.KEY_BIT_RATE, CapsuleRecapContract.VIDEO_BIT_RATE);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, CapsuleRecapContract.FRAME_RATE);
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);

            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codecSurface = encoder.createInputSurface();
            encoder.start();
            encoderStarted = true;

            muxer = new MediaMuxer(
                output.getAbsolutePath(),
                MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
            );
            inputSurface = new CodecInputSurface(codecSurface);
            codecSurface = null;
            inputSurface.makeCurrent();
            textureRenderer = new TextureRenderer();
            textureRenderer.initialize();

            try {
                frame = Bitmap.createBitmap(
                    CapsuleRecapContract.WIDTH,
                    CapsuleRecapContract.HEIGHT,
                    Bitmap.Config.ARGB_8888
                );
            } catch (OutOfMemoryError error) {
                throw new IOException("The capsule recap could not allocate a video frame.", error);
            }
            Canvas canvas = new Canvas(frame);
            Paint paint = new Paint(
                Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG | Paint.DITHER_FLAG
            );

            long frameIndex = 0;
            for (File image : images) {
                ensureRenderActive();
                Bitmap decoded = BitmapFactory.decodeFile(image.getAbsolutePath());
                if (decoded == null) {
                    throw new IOException("This capsule image could not be decoded.");
                }
                try {
                    frame.eraseColor(Color.BLACK);
                    float[] destination = CapsuleRecapContract.coverDestination(
                        decoded.getWidth(),
                        decoded.getHeight()
                    );
                    canvas.drawBitmap(
                        decoded,
                        null,
                        new RectF(
                            destination[0],
                            destination[1],
                            destination[2],
                            destination[3]
                        ),
                        paint
                    );
                } finally {
                    decoded.recycle();
                }

                textureRenderer.upload(frame);
                for (int repeat = 0; repeat < CapsuleRecapContract.FRAMES_PER_IMAGE; repeat++) {
                    ensureRenderActive();
                    textureRenderer.draw();
                    inputSurface.setPresentationTime(
                        frameIndex * 1_000_000_000L / CapsuleRecapContract.FRAME_RATE
                    );
                    if (!inputSurface.swapBuffers()) {
                        throw new IOException("The capsule recap could not submit a video frame.");
                    }
                    drainEncoder(encoder, muxer, muxerState, false);
                    frameIndex += 1;
                }
            }

            encoder.signalEndOfInputStream();
            drainEncoder(encoder, muxer, muxerState, true);
            if (!muxerState.started) {
                throw new IOException("The capsule recap encoder produced no video track.");
            }
            textureRenderer.release();
            textureRenderer = null;
            inputSurface.release();
            inputSurface = null;
            encoder.stop();
            encoderStarted = false;
            encoder.release();
            encoder = null;
            muxer.stop();
            muxerState.started = false;
            muxer.release();
            muxer = null;
            completed = true;
        } catch (OutOfMemoryError error) {
            throw new IOException("The capsule recap could not allocate a video frame.", error);
        } catch (RuntimeException exception) {
            throw new IOException(
                "The capsule recap video could not be created. " + safeDetail(exception),
                exception
            );
        } finally {
            if (frame != null && !frame.isRecycled()) {
                frame.recycle();
            }
            if (textureRenderer != null) {
                textureRenderer.release();
            }
            if (inputSurface != null) {
                inputSurface.release();
            }
            if (codecSurface != null) {
                codecSurface.release();
            }
            if (encoder != null) {
                if (encoderStarted) {
                    try {
                        encoder.stop();
                    } catch (RuntimeException ignored) {
                        // Encoder cleanup is best effort after a failed render.
                    }
                }
                try {
                    encoder.release();
                } catch (RuntimeException ignored) {
                    // Encoder release is best effort after a failed render.
                }
            }
            if (muxer != null) {
                if (muxerState.started) {
                    try {
                        muxer.stop();
                    } catch (RuntimeException ignored) {
                        // A failed muxer may not have a complete track to stop.
                    }
                }
                try {
                    muxer.release();
                } catch (RuntimeException ignored) {
                    // Muxer release is best effort after a failed render.
                }
            }
            if (!completed) {
                //noinspection ResultOfMethodCallIgnored -- incomplete videos must not survive.
                output.delete();
            }
        }
    }

    /**
     * Moves available codec buffers into the muxer. Regular drains return as
     * soon as output pauses; the final drain waits only within a fixed deadline.
     */
    private static void drainEncoder(
        MediaCodec encoder,
        MediaMuxer muxer,
        MuxerState state,
        boolean endOfStream
    ) throws IOException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long deadline = System.nanoTime() + END_OF_STREAM_TIMEOUT_NANOSECONDS;

        while (true) {
            ensureRenderActive();
            // Apply one absolute deadline to the entire final drain. A broken
            // codec may keep returning zero-byte or configuration buffers, so
            // checking only dequeue timeouts would not actually bound this loop.
            if (endOfStream) {
                ensureBeforeDeadline(System.nanoTime(), deadline);
            }
            int status = encoder.dequeueOutputBuffer(info, CODEC_TIMEOUT_MICROSECONDS);
            if (status == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                if (state.started) {
                    throw new IOException("The capsule recap encoder changed format twice.");
                }
                state.trackIndex = muxer.addTrack(encoder.getOutputFormat());
                muxer.start();
                state.started = true;
                continue;
            }
            if (status < 0) {
                // Negative statuses contain no encoded buffer. A regular drain
                // can return until the next submitted frame; the final drain is
                // allowed to poll only within its fixed completion deadline.
                if (!endOfStream) {
                    return;
                }
                continue;
            }

            ByteBuffer encoded = encoder.getOutputBuffer(status);
            if (encoded == null) {
                throw new IOException("The capsule recap encoder returned an empty buffer.");
            }
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                info.size = 0;
            }
            if (info.size > 0) {
                if (!state.started) {
                    throw new IOException("The capsule recap video track is unavailable.");
                }
                encoded.position(info.offset);
                encoded.limit(info.offset + info.size);
                muxer.writeSampleData(state.trackIndex, encoded, info);
            }
            encoder.releaseOutputBuffer(status, false);

            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                return;
            }
        }
    }

    /** Throws once the final codec drain reaches its absolute deadline. */
    static void ensureBeforeDeadline(
        long currentTimeNanos,
        long deadlineNanos
    ) throws IOException {
        if (currentTimeNanos >= deadlineNanos) {
            throw new IOException("The capsule recap encoder did not finish in time.");
        }
    }

    /** Supplies a stable diagnostic suffix when an exception carries no message. */
    private static String safeDetail(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
            ? error.getClass().getSimpleName()
            : message;
    }

    /** Stops lifecycle-cancelled renders instead of draining the full image list. */
    private static void ensureRenderActive() throws IOException {
        if (Thread.currentThread().isInterrupted()) {
            throw new IOException("The capsule recap render was cancelled.");
        }
    }

    /** Mutable track state shared across incremental codec drains. */
    private static final class MuxerState {
        int trackIndex = -1;
        boolean started;
    }

    /** EGL wrapper adapted to the Android MediaCodec input-surface contract. */
    private static final class CodecInputSurface {

        private static final int EGL_RECORDABLE_ANDROID = 0x3142;

        private Surface surface;
        private EGLDisplay display = EGL14.EGL_NO_DISPLAY;
        private EGLContext context = EGL14.EGL_NO_CONTEXT;
        private EGLSurface eglSurface = EGL14.EGL_NO_SURFACE;

        /** Takes ownership of the codec surface and initializes its recordable EGL context. */
        CodecInputSurface(Surface surface) throws IOException {
            if (surface == null) {
                throw new IOException("The capsule recap encoder has no input surface.");
            }
            this.surface = surface;
            try {
                setupEgl();
            } catch (IOException | RuntimeException exception) {
                release();
                throw exception;
            }
        }

        /** Binds this encoder surface and context to the calling render thread. */
        void makeCurrent() throws IOException {
            if (!EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) {
                throw new IOException("The capsule recap drawing surface could not be activated.");
            }
        }

        /** Submits the current GL frame to the encoder's input queue. */
        boolean swapBuffers() {
            return EGL14.eglSwapBuffers(display, eglSurface);
        }

        /** Associates a monotonic media timestamp with the next submitted frame. */
        void setPresentationTime(long nanoseconds) throws IOException {
            if (!EGLExt.eglPresentationTimeANDROID(display, eglSurface, nanoseconds)) {
                throw new IOException("The capsule recap frame timestamp could not be submitted.");
            }
        }

        /** Releases EGL objects in dependency order, then releases the owned codec surface. */
        void release() {
            if (display != EGL14.EGL_NO_DISPLAY) {
                EGL14.eglMakeCurrent(
                    display,
                    EGL14.EGL_NO_SURFACE,
                    EGL14.EGL_NO_SURFACE,
                    EGL14.EGL_NO_CONTEXT
                );
                if (eglSurface != EGL14.EGL_NO_SURFACE) {
                    EGL14.eglDestroySurface(display, eglSurface);
                }
                if (context != EGL14.EGL_NO_CONTEXT) {
                    EGL14.eglDestroyContext(display, context);
                }
                EGL14.eglReleaseThread();
                EGL14.eglTerminate(display);
            }
            if (surface != null) {
                surface.release();
                surface = null;
            }
            display = EGL14.EGL_NO_DISPLAY;
            context = EGL14.EGL_NO_CONTEXT;
            eglSurface = EGL14.EGL_NO_SURFACE;
        }

        /** Selects an ES2 config that Android permits MediaCodec to record. */
        private void setupEgl() throws IOException {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
            if (display == EGL14.EGL_NO_DISPLAY) {
                throw new IOException("The capsule recap display is unavailable.");
            }
            int[] version = new int[2];
            if (!EGL14.eglInitialize(display, version, 0, version, 1)) {
                throw new IOException("The capsule recap display could not initialize.");
            }

            int[] attributes = {
                EGL14.EGL_RED_SIZE, 8,
                EGL14.EGL_GREEN_SIZE, 8,
                EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                EGL_RECORDABLE_ANDROID, 1,
                EGL14.EGL_NONE
            };
            EGLConfig[] configs = new EGLConfig[1];
            int[] count = new int[1];
            if (
                !EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) ||
                count[0] <= 0
            ) {
                throw new IOException("No recordable Capsule recap surface is available.");
            }

            int[] contextAttributes = {
                EGL14.EGL_CONTEXT_CLIENT_VERSION, 2,
                EGL14.EGL_NONE
            };
            context = EGL14.eglCreateContext(
                display,
                configs[0],
                EGL14.EGL_NO_CONTEXT,
                contextAttributes,
                0
            );
            checkEgl("create context");

            int[] surfaceAttributes = { EGL14.EGL_NONE };
            eglSurface = EGL14.eglCreateWindowSurface(
                display,
                configs[0],
                surface,
                surfaceAttributes,
                0
            );
            checkEgl("create window surface");
        }

        /** Converts the pending EGL error into an actionable render failure. */
        private static void checkEgl(String operation) throws IOException {
            int error = EGL14.eglGetError();
            if (error != EGL14.EGL_SUCCESS) {
                throw new IOException(
                    "The capsule recap could not " + operation + " (EGL 0x" +
                        Integer.toHexString(error) + ")."
                );
            }
        }
    }

    /** Owns the reusable GL program and texture that draw each prepared bitmap. */
    private static final class TextureRenderer {

        private static final float[] VERTICES = {
            -1f, -1f,
             1f, -1f,
            -1f,  1f,
             1f,  1f
        };
        // Bitmap row zero is the top row, so V is flipped for screen display.
        private static final float[] TEXTURE_COORDINATES = {
            0f, 1f,
            1f, 1f,
            0f, 0f,
            1f, 0f
        };
        private static final String VERTEX_SHADER =
            "attribute vec4 aPosition;\n" +
            "attribute vec2 aTextureCoordinate;\n" +
            "varying vec2 vTextureCoordinate;\n" +
            "void main() {\n" +
            "  gl_Position = aPosition;\n" +
            "  vTextureCoordinate = aTextureCoordinate;\n" +
            "}\n";
        private static final String FRAGMENT_SHADER =
            "precision mediump float;\n" +
            "uniform sampler2D uTexture;\n" +
            "varying vec2 vTextureCoordinate;\n" +
            "void main() {\n" +
            "  gl_FragColor = texture2D(uTexture, vTextureCoordinate);\n" +
            "}\n";

        private final FloatBuffer vertexBuffer = floatBuffer(VERTICES);
        private final FloatBuffer textureBuffer = floatBuffer(TEXTURE_COORDINATES);
        private int program;
        private int texture;
        private int positionHandle;
        private int textureCoordinateHandle;
        private int samplerHandle;

        /** Compiles the shaders and allocates a clamped 2D texture in the active context. */
        void initialize() throws IOException {
            int vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER);
            final int fragmentShader;
            try {
                fragmentShader = compileShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER);
            } catch (IOException | RuntimeException exception) {
                GLES20.glDeleteShader(vertexShader);
                throw exception;
            }
            program = GLES20.glCreateProgram();
            if (program == 0) {
                GLES20.glDeleteShader(vertexShader);
                GLES20.glDeleteShader(fragmentShader);
                throw new IOException("The capsule recap shader program could not be allocated.");
            }
            GLES20.glAttachShader(program, vertexShader);
            GLES20.glAttachShader(program, fragmentShader);
            GLES20.glLinkProgram(program);
            int[] linked = new int[1];
            GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0);
            GLES20.glDeleteShader(vertexShader);
            GLES20.glDeleteShader(fragmentShader);
            if (linked[0] == 0) {
                String detail = GLES20.glGetProgramInfoLog(program);
                GLES20.glDeleteProgram(program);
                program = 0;
                throw new IOException("The capsule recap shader could not link. " + detail);
            }

            positionHandle = GLES20.glGetAttribLocation(program, "aPosition");
            textureCoordinateHandle = GLES20.glGetAttribLocation(program, "aTextureCoordinate");
            samplerHandle = GLES20.glGetUniformLocation(program, "uTexture");
            if (positionHandle < 0 || textureCoordinateHandle < 0 || samplerHandle < 0) {
                throw new IOException("The capsule recap shader controls are unavailable.");
            }

            int[] textures = new int[1];
            GLES20.glGenTextures(1, textures, 0);
            if (textures[0] == 0) {
                throw new IOException("The capsule recap texture could not be allocated.");
            }
            texture = textures[0];
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
            GLES20.glTexParameteri(
                GLES20.GL_TEXTURE_2D,
                GLES20.GL_TEXTURE_MIN_FILTER,
                GLES20.GL_LINEAR
            );
            GLES20.glTexParameteri(
                GLES20.GL_TEXTURE_2D,
                GLES20.GL_TEXTURE_MAG_FILTER,
                GLES20.GL_LINEAR
            );
            GLES20.glTexParameteri(
                GLES20.GL_TEXTURE_2D,
                GLES20.GL_TEXTURE_WRAP_S,
                GLES20.GL_CLAMP_TO_EDGE
            );
            GLES20.glTexParameteri(
                GLES20.GL_TEXTURE_2D,
                GLES20.GL_TEXTURE_WRAP_T,
                GLES20.GL_CLAMP_TO_EDGE
            );
            checkGl("create texture");
        }

        /** Replaces the reusable texture contents with the next fixed-size bitmap frame. */
        void upload(Bitmap frame) throws IOException {
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, frame, 0);
            checkGl("upload image");
        }

        /** Draws the current texture once across the encoder's full output surface. */
        void draw() throws IOException {
            GLES20.glViewport(0, 0, CapsuleRecapContract.WIDTH, CapsuleRecapContract.HEIGHT);
            GLES20.glClearColor(0f, 0f, 0f, 1f);
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
            GLES20.glUseProgram(program);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
            GLES20.glUniform1i(samplerHandle, 0);

            vertexBuffer.position(0);
            GLES20.glEnableVertexAttribArray(positionHandle);
            GLES20.glVertexAttribPointer(
                positionHandle,
                2,
                GLES20.GL_FLOAT,
                false,
                0,
                vertexBuffer
            );
            textureBuffer.position(0);
            GLES20.glEnableVertexAttribArray(textureCoordinateHandle);
            GLES20.glVertexAttribPointer(
                textureCoordinateHandle,
                2,
                GLES20.GL_FLOAT,
                false,
                0,
                textureBuffer
            );
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
            GLES20.glDisableVertexAttribArray(positionHandle);
            GLES20.glDisableVertexAttribArray(textureCoordinateHandle);
            checkGl("draw frame");
        }

        /** Deletes this renderer's texture and program from the current GL context. */
        void release() {
            if (texture != 0) {
                GLES20.glDeleteTextures(1, new int[] { texture }, 0);
                texture = 0;
            }
            if (program != 0) {
                GLES20.glDeleteProgram(program);
                program = 0;
            }
        }

        /** Compiles one GL shader and deletes the failed handle before throwing. */
        private static int compileShader(int type, String source) throws IOException {
            int shader = GLES20.glCreateShader(type);
            if (shader == 0) {
                throw new IOException("The capsule recap shader could not be allocated.");
            }
            GLES20.glShaderSource(shader, source);
            GLES20.glCompileShader(shader);
            int[] compiled = new int[1];
            GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0);
            if (compiled[0] == 0) {
                String detail = GLES20.glGetShaderInfoLog(shader);
                GLES20.glDeleteShader(shader);
                throw new IOException("The capsule recap shader could not compile. " + detail);
            }
            return shader;
        }

        /** Copies vertex data into native-order memory accepted by OpenGL ES. */
        private static FloatBuffer floatBuffer(float[] values) {
            ByteBuffer bytes = ByteBuffer.allocateDirect(values.length * 4);
            bytes.order(ByteOrder.nativeOrder());
            FloatBuffer buffer = bytes.asFloatBuffer();
            buffer.put(values);
            buffer.position(0);
            return buffer;
        }

        /** Converts the pending GL error into an actionable render failure. */
        private static void checkGl(String operation) throws IOException {
            int error = GLES20.glGetError();
            if (error != GLES20.GL_NO_ERROR) {
                throw new IOException(
                    "The capsule recap could not " + operation + " (GL 0x" +
                        Integer.toHexString(error) + ")."
                );
            }
        }
    }
}
