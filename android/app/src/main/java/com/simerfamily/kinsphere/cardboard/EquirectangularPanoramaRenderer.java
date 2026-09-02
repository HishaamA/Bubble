package com.simerfamily.kinsphere.cardboard;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.opengl.GLES20;
import android.opengl.GLUtils;
import android.opengl.Matrix;
import com.google.cardboard.sdk.CardboardView;
import com.google.cardboard.sdk.HeadTransform;
import com.google.cardboard.sdk.Viewport;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.microedition.khronos.egl.EGLConfig;

/** Draws one monoscopic equirectangular image through Cardboard's calibrated eye pass. */
final class EquirectangularPanoramaRenderer implements CardboardView.Renderer {

    /** Receives the first terminal renderer failure on the Activity thread. */
    interface FailureListener {
        /** Reports a user-safe reason the VR image can no longer be drawn. */
        void onFailure(String message);
    }

    private static final float Z_NEAR = 0.1f;
    private static final float Z_FAR = 100f;
    private static final int MAX_TEXTURE_EDGE = 8192;
    private static final long MAX_DECODED_PIXELS = 33_554_432L;

    private static final String VERTEX_SHADER =
        "attribute vec2 aPosition;\n" +
        "varying mediump vec2 vClipPosition;\n" +
        "void main() {\n" +
        "  vClipPosition = aPosition;\n" +
        "  gl_Position = vec4(aPosition, 0.0, 1.0);\n" +
        "}\n";

    private static final String FRAGMENT_SHADER =
        "#ifdef GL_FRAGMENT_PRECISION_HIGH\n" +
        "precision highp float;\n" +
        "#else\n" +
        "precision mediump float;\n" +
        "#endif\n" +
        "uniform sampler2D uPanorama;\n" +
        "uniform mat4 uInverseProjectionMatrix;\n" +
        "uniform mat4 uInverseModelViewMatrix;\n" +
        "varying mediump vec2 vClipPosition;\n" +
        "const float PI = 3.1415926535897932384626433832795;\n" +
        "void main() {\n" +
        "  vec4 eyeRay = uInverseProjectionMatrix * vec4(vClipPosition, 1.0, 1.0);\n" +
        "  vec3 panoramaRay = normalize((uInverseModelViewMatrix * vec4(normalize(eyeRay.xyz), 0.0)).xyz);\n" +
        "  float yaw = atan(panoramaRay.x, -panoramaRay.z);\n" +
        "  float pitch = asin(clamp(panoramaRay.y, -1.0, 1.0));\n" +
        "  vec2 uv = vec2(fract(0.5 + yaw / (2.0 * PI)), 0.5 - pitch / PI);\n" +
        "  gl_FragColor = texture2D(uPanorama, uv);\n" +
        "}\n";

    private final File panoramaFile;
    private final FailureListener failureListener;
    private final AtomicBoolean shuttingDown = new AtomicBoolean();
    private final AtomicBoolean failureReported = new AtomicBoolean();
    private final float[] headView = new float[16];
    private final float[] monoscopicEyeView = new float[16];
    private final float[] modelMatrix = new float[16];
    private final float[] modelViewMatrix = new float[16];
    private final float[] inverseProjectionMatrix = new float[16];
    private final float[] inverseModelViewMatrix = new float[16];

    private FloatBuffer vertexBuffer;
    private int program;
    private int texture;
    private int positionLocation;
    private int inverseProjectionMatrixLocation;
    private int inverseModelViewMatrixLocation;
    private int panoramaSamplerLocation;
    private volatile boolean ready;

    /** Prepares immutable panorama inputs and the initial camera orientation. */
    EquirectangularPanoramaRenderer(
        File panoramaFile,
        float initialYaw,
        float initialPitch,
        FailureListener failureListener
    ) {
        this.panoramaFile = panoramaFile;
        this.failureListener = failureListener;
        Matrix.setIdentityM(headView, 0);
        Matrix.setIdentityM(modelMatrix, 0);
        // The shader applies inverse(modelView) to its camera ray. Building the
        // inverse initial view here preserves iOS's Ry(-yaw) * Rx(+pitch) order.
        Matrix.rotateM(modelMatrix, 0, -initialPitch, 1f, 0f, 0f);
        Matrix.rotateM(modelMatrix, 0, initialYaw, 0f, 1f, 0f);
    }

    /** Copies Cardboard's latest head transform for the subsequent eye passes. */
    @Override
    public void onNewFrame(HeadTransform headTransform) {
        if (shuttingDown.get()) {
            return;
        }
        headTransform.getHeadView(headView, 0);
    }

    /** Projects one monoscopic panorama ray through the profile-calibrated eye frustum. */
    @Override
    public void onDrawEye(CardboardView.Eye eye) {
        if (!ready || shuttingDown.get()) {
            return;
        }

        eye.applyHeadView(headView);
        System.arraycopy(eye.getEyeView(), 0, monoscopicEyeView, 0, 16);
        // A stitched 360 photo has no binocular depth. Keep Cardboard's
        // profile-derived asymmetric projection, but remove eye/neck-model
        // translation so both eyes sample the same ray and cannot invent
        // false parallax in a monoscopic panorama.
        monoscopicEyeView[12] = 0f;
        monoscopicEyeView[13] = 0f;
        monoscopicEyeView[14] = 0f;

        Matrix.multiplyMM(
            modelViewMatrix,
            0,
            monoscopicEyeView,
            0,
            modelMatrix,
            0
        );
        if (
            !Matrix.invertM(inverseModelViewMatrix, 0, modelViewMatrix, 0) ||
            !Matrix.invertM(
                inverseProjectionMatrix,
                0,
                eye.getPerspective(Z_NEAR, Z_FAR),
                0
            )
        ) {
            reportFailure("This 360 image could not be projected in VR.");
            return;
        }

        GLES20.glUseProgram(program);
        GLES20.glDisable(GLES20.GL_CULL_FACE);
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);

        vertexBuffer.position(0);
        GLES20.glEnableVertexAttribArray(positionLocation);
        GLES20.glVertexAttribPointer(
            positionLocation,
            2,
            GLES20.GL_FLOAT,
            false,
            0,
            vertexBuffer
        );

        GLES20.glUniformMatrix4fv(
            inverseProjectionMatrixLocation,
            1,
            false,
            inverseProjectionMatrix,
            0
        );
        GLES20.glUniformMatrix4fv(
            inverseModelViewMatrixLocation,
            1,
            false,
            inverseModelViewMatrix,
            0
        );
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLES20.glUniform1i(panoramaSamplerLocation, 0);

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);

        GLES20.glDisableVertexAttribArray(positionLocation);
    }

    /** Leaves final lens distortion and frame submission to {@link CardboardView}. */
    @Override
    public void onFinishFrame(Viewport viewport) {
        // CardboardView performs the profile-derived distortion pass after both eyes.
    }

    /** Leaves per-eye viewport sizing to {@link CardboardView}. */
    @Override
    public void onSurfaceChanged(int width, int height) {
        // CardboardView owns the per-eye viewport and rebuilds it for profile changes.
    }

    /** Rebuilds every GL handle whenever Cardboard creates or replaces its EGL context. */
    @Override
    public void onSurfaceCreated(EGLConfig config) {
        if (shuttingDown.get()) {
            return;
        }
        ready = false;
        // A recreated EGL context does not retain handles from the old context.
        program = 0;
        texture = 0;
        try {
            buildFullscreenQuad();
            program = createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
            positionLocation = GLES20.glGetAttribLocation(program, "aPosition");
            inverseProjectionMatrixLocation = GLES20.glGetUniformLocation(
                program,
                "uInverseProjectionMatrix"
            );
            inverseModelViewMatrixLocation = GLES20.glGetUniformLocation(
                program,
                "uInverseModelViewMatrix"
            );
            panoramaSamplerLocation = GLES20.glGetUniformLocation(program, "uPanorama");
            if (
                positionLocation < 0 ||
                inverseProjectionMatrixLocation < 0 ||
                inverseModelViewMatrixLocation < 0 ||
                panoramaSamplerLocation < 0
            ) {
                throw new IllegalStateException("Panorama shader inputs are unavailable");
            }
            texture = loadPanoramaTexture(panoramaFile);
            GLES20.glClearColor(0f, 0f, 0f, 1f);
            ready = true;
        } catch (RuntimeException | OutOfMemoryError error) {
            releaseGlResources();
            reportFailure("This 360 image could not be rendered in VR.");
        }
    }

    /** Marks rendering closed before releasing objects owned by the active GL context. */
    @Override
    public void onRendererShutdown() {
        requestShutdown();
        releaseGlResources();
    }

    /** Prevents new draw work while Activity teardown waits for the renderer callback. */
    void requestShutdown() {
        shuttingDown.set(true);
        ready = false;
    }

    /** Allocates the clip-space quad whose fragments reconstruct panorama rays. */
    private void buildFullscreenQuad() {
        // iOS uses the same four-vertex ray projection. The panorama direction
        // is reconstructed for every fragment, so no sphere facets can become
        // visible regardless of field of view or lens distortion.
        vertexBuffer = directFloatBuffer(
            new float[] { -1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f }
        );
    }

    /** Copies vertex data into native-order storage accepted by OpenGL ES. */
    private static FloatBuffer directFloatBuffer(float[] values) {
        FloatBuffer buffer = ByteBuffer
            .allocateDirect(values.length * Float.BYTES)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer();
        buffer.put(values).position(0);
        return buffer;
    }

    /** Decodes within device texture limits and uploads one clamped panorama texture. */
    private static int loadPanoramaTexture(File file) {
        int[] maximumTextureSize = new int[1];
        GLES20.glGetIntegerv(GLES20.GL_MAX_TEXTURE_SIZE, maximumTextureSize, 0);
        int maximumEdge = Math.min(Math.max(maximumTextureSize[0], 1), MAX_TEXTURE_EDGE);

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IllegalArgumentException("Panorama dimensions are invalid");
        }

        int sampleSize = 1;
        while (
            bounds.outWidth / sampleSize > maximumEdge ||
            bounds.outHeight / sampleSize > maximumEdge ||
            ((long) Math.max(1, bounds.outWidth / sampleSize) *
                Math.max(1, bounds.outHeight / sampleSize)) > MAX_DECODED_PIXELS
        ) {
            sampleSize *= 2;
        }

        BitmapFactory.Options decodeOptions = new BitmapFactory.Options();
        decodeOptions.inSampleSize = sampleSize;
        decodeOptions.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap panoramaBitmap = BitmapFactory.decodeFile(file.getAbsolutePath(), decodeOptions);
        if (panoramaBitmap == null) {
            throw new IllegalArgumentException("Panorama bitmap could not be decoded");
        }

        int[] textures = new int[1];
        GLES20.glGenTextures(1, textures, 0);
        if (textures[0] == 0) {
            panoramaBitmap.recycle();
            throw new IllegalStateException("Panorama texture could not be allocated");
        }
        try {
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textures[0]);
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
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, panoramaBitmap, 0);
            assertNoGlError("upload panorama texture");
            return textures[0];
        } catch (RuntimeException | OutOfMemoryError error) {
            GLES20.glDeleteTextures(1, textures, 0);
            throw error;
        } finally {
            panoramaBitmap.recycle();
        }
    }

    /** Compiles and links a complete shader program, releasing intermediate handles. */
    private static int createProgram(String vertexSource, String fragmentSource) {
        int vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, vertexSource);
        final int fragmentShader;
        try {
            fragmentShader = compileShader(GLES20.GL_FRAGMENT_SHADER, fragmentSource);
        } catch (RuntimeException | OutOfMemoryError error) {
            GLES20.glDeleteShader(vertexShader);
            throw error;
        }
        int linkedProgram = GLES20.glCreateProgram();
        if (linkedProgram == 0) {
            GLES20.glDeleteShader(vertexShader);
            GLES20.glDeleteShader(fragmentShader);
            throw new IllegalStateException("Panorama program could not be allocated");
        }
        GLES20.glAttachShader(linkedProgram, vertexShader);
        GLES20.glAttachShader(linkedProgram, fragmentShader);
        GLES20.glLinkProgram(linkedProgram);

        int[] linkStatus = new int[1];
        GLES20.glGetProgramiv(linkedProgram, GLES20.GL_LINK_STATUS, linkStatus, 0);
        GLES20.glDeleteShader(vertexShader);
        GLES20.glDeleteShader(fragmentShader);
        if (linkStatus[0] == 0) {
            String log = GLES20.glGetProgramInfoLog(linkedProgram);
            GLES20.glDeleteProgram(linkedProgram);
            throw new IllegalStateException("Panorama program link failed: " + log);
        }
        return linkedProgram;
    }

    /** Compiles one shader or deletes its failed GL handle before throwing. */
    private static int compileShader(int type, String source) {
        int shader = GLES20.glCreateShader(type);
        if (shader == 0) {
            throw new IllegalStateException("Panorama shader could not be allocated");
        }
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        int[] compileStatus = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compileStatus, 0);
        if (compileStatus[0] == 0) {
            String log = GLES20.glGetShaderInfoLog(shader);
            GLES20.glDeleteShader(shader);
            throw new IllegalStateException("Panorama shader compile failed: " + log);
        }
        return shader;
    }

    /** Converts the pending GL error into a terminal renderer failure. */
    private static void assertNoGlError(String operation) {
        int error = GLES20.glGetError();
        if (error != GLES20.GL_NO_ERROR) {
            throw new IllegalStateException(operation + " failed with GL error " + error);
        }
    }

    /** Publishes only the first failure so Activity teardown cannot be re-entered. */
    private void reportFailure(String message) {
        ready = false;
        if (failureReported.compareAndSet(false, true) && failureListener != null) {
            failureListener.onFailure(message);
        }
    }

    /** Deletes only handles owned by the currently active GL context. */
    private void releaseGlResources() {
        if (texture != 0) {
            GLES20.glDeleteTextures(1, new int[] { texture }, 0);
            texture = 0;
        }
        if (program != 0) {
            GLES20.glDeleteProgram(program);
            program = 0;
        }
    }
}
