package com.simerfamily.kinsphere.panorama;

import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.util.Log;
import com.google.ar.core.Camera;
import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;
import com.google.ar.core.Session;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/** Draws ARCore's camera texture and forwards each synchronized pose/image frame. */
final class ArCameraRenderer implements GLSurfaceView.Renderer {

    /** Receives synchronized frame data or the renderer's first terminal failure. */
    interface Listener {
        /** Delivers pose, projection, and CPU-image access from the same ARCore frame. */
        void onFrame(Frame frame, Camera camera, float[] cameraToWorld, float[] projection);

        /** Reports a failure that makes further GL-frame processing unsafe. */
        void onFailure(Exception error);
    }

    private static final String TAG = "BubbleArPreview";
    private static final float[] QUAD = {
        -1.0f, -1.0f,
        1.0f, -1.0f,
        -1.0f, 1.0f,
        1.0f, 1.0f,
    };
    private static final String VERTEX_SHADER =
        "attribute vec2 aPosition;\n" +
        "attribute vec2 aTexCoord;\n" +
        "varying vec2 vTexCoord;\n" +
        "void main() {\n" +
        "  gl_Position = vec4(aPosition, 0.0, 1.0);\n" +
        "  vTexCoord = aTexCoord;\n" +
        "}\n";
    private static final String FRAGMENT_SHADER =
        "#extension GL_OES_EGL_image_external : require\n" +
        "precision mediump float;\n" +
        "uniform samplerExternalOES uTexture;\n" +
        "varying vec2 vTexCoord;\n" +
        "void main() {\n" +
        "  gl_FragColor = texture2D(uTexture, vTexCoord);\n" +
        "}\n";

    private final Listener listener;
    private final FloatBuffer quadCoordinates = floatBuffer(QUAD);
    private final FloatBuffer textureCoordinates = floatBuffer(new float[8]);
    private final float[] cameraToWorld = new float[16];
    private final float[] projection = new float[16];
    private volatile Session session;
    private volatile int displayRotation;
    private volatile int viewportWidth;
    private volatile int viewportHeight;
    private Session textureSession;
    private int textureId = -1;
    private int program;
    private int positionAttribute;
    private int textureAttribute;
    private int textureUniform;
    private boolean textureCoordinatesReady;
    private volatile boolean failurePublished;

    /** Creates a renderer that forwards accepted frame data to one Activity listener. */
    ArCameraRenderer(Listener listener) {
        this.listener = listener;
    }

    /** Rebinds camera texture state when the Activity creates or replaces its ARCore session. */
    void setSession(Session session) {
        textureCoordinatesReady = false;
        failurePublished = false;
        this.session = session;
    }

    /** Records Android display rotation for ARCore's next texture-coordinate transform. */
    void setDisplayRotation(int displayRotation) {
        this.displayRotation = displayRotation;
    }

    /** Recreates all GL resources because handles never survive an EGL context replacement. */
    @Override
    public void onSurfaceCreated(GL10 ignored, EGLConfig config) {
        textureId = -1;
        program = 0;
        // Every EGL context owns different texture names, even when the ARCore
        // Session object itself survived a short pause.
        textureSession = null;
        textureCoordinatesReady = false;
        try {
            initializeGlResources();
        } catch (RuntimeException error) {
            releaseGlResources();
            publishFailure(error);
        }
    }

    /** Allocates the external camera texture and links the preview shader program. */
    private void initializeGlResources() {
        GLES20.glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
        int[] textures = new int[1];
        GLES20.glGenTextures(1, textures, 0);
        if (textures[0] == 0) {
            throw new IllegalStateException("AR camera texture allocation failed");
        }
        textureId = textures[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_WRAP_S,
            GLES20.GL_CLAMP_TO_EDGE
        );
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_WRAP_T,
            GLES20.GL_CLAMP_TO_EDGE
        );
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_MIN_FILTER,
            GLES20.GL_LINEAR
        );
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_MAG_FILTER,
            GLES20.GL_LINEAR
        );

        int vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER);
        final int fragmentShader;
        try {
            fragmentShader = compileShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER);
        } catch (RuntimeException error) {
            GLES20.glDeleteShader(vertexShader);
            throw error;
        }
        program = GLES20.glCreateProgram();
        if (program == 0) {
            GLES20.glDeleteShader(vertexShader);
            GLES20.glDeleteShader(fragmentShader);
            throw new IllegalStateException("AR camera shader program allocation failed");
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
            throw new IllegalStateException("AR camera shader link failed: " + detail);
        }
        positionAttribute = GLES20.glGetAttribLocation(program, "aPosition");
        textureAttribute = GLES20.glGetAttribLocation(program, "aTexCoord");
        textureUniform = GLES20.glGetUniformLocation(program, "uTexture");
        if (positionAttribute < 0 || textureAttribute < 0 || textureUniform < 0) {
            throw new IllegalStateException("AR camera shader inputs are unavailable");
        }
    }

    /** Updates the viewport and invalidates texture coordinates after a surface resize. */
    @Override
    public void onSurfaceChanged(GL10 ignored, int width, int height) {
        viewportWidth = Math.max(1, width);
        viewportHeight = Math.max(1, height);
        textureCoordinatesReady = false;
        GLES20.glViewport(0, 0, viewportWidth, viewportHeight);
    }

    /** Advances ARCore once, draws its camera texture, and publishes matching pose data. */
    @Override
    public void onDrawFrame(GL10 ignored) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        if (failurePublished) {
            return;
        }
        Session activeSession = session;
        if (activeSession == null || textureId < 0 || viewportWidth <= 0 || viewportHeight <= 0) {
            return;
        }

        try {
            if (textureSession != activeSession) {
                activeSession.setCameraTextureName(textureId);
                textureSession = activeSession;
                textureCoordinatesReady = false;
            }
            activeSession.setDisplayGeometry(
                displayRotation,
                viewportWidth,
                viewportHeight
            );
            Frame frame = activeSession.update();
            if (frame.hasDisplayGeometryChanged() || !textureCoordinatesReady) {
                quadCoordinates.position(0);
                textureCoordinates.position(0);
                frame.transformCoordinates2d(
                    Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
                    quadCoordinates,
                    Coordinates2d.TEXTURE_NORMALIZED,
                    textureCoordinates
                );
                textureCoordinatesReady = true;
            }
            if (frame.getTimestamp() != 0L) {
                drawCamera();
            }

            Camera camera = frame.getCamera();
            camera.getDisplayOrientedPose().toMatrix(cameraToWorld, 0);
            camera.getProjectionMatrix(projection, 0, 0.1f, 100.0f);
            listener.onFrame(frame, camera, cameraToWorld, projection);
        } catch (Exception error) {
            publishFailure(error);
        }
    }

    /** Draws ARCore's external texture using its display-corrected coordinates. */
    private void drawCamera() {
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glDepthMask(false);
        GLES20.glUseProgram(program);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glUniform1i(textureUniform, 0);

        quadCoordinates.position(0);
        textureCoordinates.position(0);
        GLES20.glVertexAttribPointer(
            positionAttribute,
            2,
            GLES20.GL_FLOAT,
            false,
            0,
            quadCoordinates
        );
        GLES20.glVertexAttribPointer(
            textureAttribute,
            2,
            GLES20.GL_FLOAT,
            false,
            0,
            textureCoordinates
        );
        GLES20.glEnableVertexAttribArray(positionAttribute);
        GLES20.glEnableVertexAttribArray(textureAttribute);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(positionAttribute);
        GLES20.glDisableVertexAttribArray(textureAttribute);
        GLES20.glDepthMask(true);
        GLES20.glEnable(GLES20.GL_DEPTH_TEST);
    }

    /** Compiles one shader and deletes its handle before reporting compilation failure. */
    private static int compileShader(int type, String source) {
        int shader = GLES20.glCreateShader(type);
        if (shader == 0) {
            throw new IllegalStateException("AR camera shader allocation failed");
        }
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        int[] compiled = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0);
        if (compiled[0] == 0) {
            String message = GLES20.glGetShaderInfoLog(shader);
            GLES20.glDeleteShader(shader);
            throw new IllegalStateException("AR camera shader compilation failed: " + message);
        }
        return shader;
    }

    /** Publishes only the first renderer failure to prevent repeated Activity shutdown. */
    private void publishFailure(Exception error) {
        if (failurePublished) {
            return;
        }
        failurePublished = true;
        Log.e(TAG, "AR camera rendering stopped", error);
        listener.onFailure(error);
    }

    /** Deletes handles that belong to the current EGL context. */
    private void releaseGlResources() {
        if (textureId > 0) {
            GLES20.glDeleteTextures(1, new int[] { textureId }, 0);
            textureId = -1;
        }
        if (program != 0) {
            GLES20.glDeleteProgram(program);
            program = 0;
        }
    }

    /** Copies coordinate arrays into native-order storage accepted by OpenGL ES. */
    private static FloatBuffer floatBuffer(float[] values) {
        FloatBuffer buffer = ByteBuffer
            .allocateDirect(values.length * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer();
        buffer.put(values);
        buffer.position(0);
        return buffer;
    }
}
