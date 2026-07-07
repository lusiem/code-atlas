from pkg.nodes import BlockNode


class Child(BlockNode):
    def __init__(self):
        super().__init__()
        self.parts = []

    def rebuild(self):
        return BlockNode.render(self)
