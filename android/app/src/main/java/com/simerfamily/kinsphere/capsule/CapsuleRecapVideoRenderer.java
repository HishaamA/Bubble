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

    void render(List<File> images, File output) throws IOException {
        if (
            images == null ||
            images.isEmpty() ||
            images.size() > CapsuleRecapContract.MAXIMUM_IMAGE_COUNT
        ) {
            throw new IOException("Add between one and 150 staged images to create a recap.");
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

    private static void drainEncoder(
        MediaCodec encoder,
        MediaMuxer muxer,
        MuxerState state,
        boolean endOfStream
    ) throws IOException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long deadline = System.nanoTime() + END_OF_STREAM_TIMEOUT_NANOSECONDS;

        while (true) {
            int status = encoder.dequeueOutputBuffer(info, CODEC_TIMEOUT_MICROSECONDS);
            if (status == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!endOfStream) {
                    return;
                }
                if (System.nanoTime() >= deadline) {
                    throw new IOException("The capsule recap encoder did not finish in time.");
                }
                continue;
            }
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

    private static String safeDetail(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
            ? error.getClass().getSimpleName()
            : message;
    }

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

        void makeCurrent() throws IOException {
            if (!EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) {
                throw new IOException("The capsule recap drawing surface could not be activated.");
            }
        }

        boolean swapBuffers() {
            return EGL14.eglSwapBuffers(display, eglSurface);
        }

        void setPresentationTime(long nanoseconds) {
            EGLExt.eglPresentationTimeANDROID(display, eglSurface, nanoseconds);
        }

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

        void initialize() throws IOException {
            int vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER);
            int fragmentShader = compileShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER);
            program = GLES20.glCreateProgram();
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

        void upload(Bitmap frame) throws IOException {
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, frame, 0);
            checkGl("upload image");
        }

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

        private static int compileShader(int type, String source) throws IOException {
            int shader = GLES20.glCreateShader(type);
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

        private static FloatBuffer floatBuffer(float[] values) {
            ByteBuffer bytes = ByteBuffer.allocateDirect(values.length * 4);
            bytes.order(ByteOrder.nativeOrder());
            FloatBuffer buffer = bytes.asFloatBuffer();
            buffer.put(values);
            buffer.position(0);
            return buffer;
        }

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
