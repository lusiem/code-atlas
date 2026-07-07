class BlockNode:
    def super(self):
        """Render the parent block's content (name collides with the builtin)."""
        return self.render()

    def render(self):
        return self.super()
