// The 3D view: the Rust static library in core/ (core/src/lib.rs documents each call and the messages rt_poll returns).
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct RtView RtView;

RtView *rt_create(void *metal_layer, uint32_t width, uint32_t height, float scale, const char *bundle, const char *assets, const char *presets);
void rt_resize(RtView *view, uint32_t width, uint32_t height, float scale);
void rt_pointer(RtView *view, float u, float v);
void rt_button(RtView *view, uint8_t button, bool down);
void rt_wheel(RtView *view, float notches);
void rt_key(RtView *view, const char *code, const char *name, bool down);
void rt_send(RtView *view, const char *json);
char *rt_poll(RtView *view);
void rt_free(char *text);
void rt_stream(RtView *view, const char *name, uint32_t width, uint32_t height, const uint8_t *rgba, size_t len);
void rt_snapshot(RtView *view, const char *path);
void rt_reload(RtView *view, const char *bundle);
void rt_quality(RtView *view, uint32_t fps, float scale, uint32_t bounces);
void rt_destroy(RtView *view);
