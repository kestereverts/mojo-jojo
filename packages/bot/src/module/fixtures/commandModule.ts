// Fixture: an external module that registers a command (exercises external loading
// end-to-end with the command framework).
export default {
  name: "ext-cmd",
  setup(ctx: {
    command: (c: { name: string; description: string; handler: (x: { reply: (t: string) => boolean }) => void }) => void;
  }) {
    ctx.command({ name: "ext", description: "external", handler: (c) => void c.reply("ext-pong") });
  },
};
