"""Scriptable, portable LightGlue early stopping using unchanged upstream weights.

The explicit nine branches preserve real data-dependent stopping in ONNX If
nodes. All parameters occur once; this is not a stack of duplicate networks.
Point pruning remains disabled. Apache-2.0 upstream attribution is bundled with
the models; these wrappers replace shape operations, not trained parameters.
"""
import torch
import torch.nn.functional as F
from torch import Tensor, nn


class SelfAttention(nn.Module):
    def __init__(self, block):
        super().__init__()
        self.qkv = block.Wqkv
        self.out = block.out_proj
        self.ffn = block.ffn

    def rotate(self, value: Tensor) -> Tensor:
        pairs = value.reshape(1, 4, -1, 32, 2)
        return torch.stack((-pairs[..., 1], pairs[..., 0]), -1).reshape(1, 4, -1, 64)

    def forward(self, descriptors: Tensor, cosine: Tensor, sine: Tensor) -> Tensor:
        qkv = self.qkv(descriptors).reshape(1, -1, 4, 64, 3).permute(0, 2, 1, 3, 4)
        q, k, v = qkv[..., 0], qkv[..., 1], qkv[..., 2]
        q = q * cosine + self.rotate(q) * sine
        k = k * cosine + self.rotate(k) * sine
        attention = (torch.matmul(q, k.transpose(2, 3)) / 8.0).softmax(-1)
        context = torch.matmul(attention, v).transpose(1, 2).reshape(1, -1, 256)
        return descriptors + self.ffn(torch.cat((descriptors, self.out(context)), -1))


class CrossAttention(nn.Module):
    def __init__(self, block):
        super().__init__()
        self.qk, self.v, self.out, self.ffn = block.to_qk, block.to_v, block.to_out, block.ffn
        self.scale = float(block.scale**0.5)

    def forward(self, desc0: Tensor, desc1: Tensor) -> tuple[Tensor, Tensor]:
        q0 = self.qk(desc0).reshape(1, -1, 4, 64).transpose(1, 2) * self.scale
        q1 = self.qk(desc1).reshape(1, -1, 4, 64).transpose(1, 2) * self.scale
        v0 = self.v(desc0).reshape(1, -1, 4, 64).transpose(1, 2)
        v1 = self.v(desc1).reshape(1, -1, 4, 64).transpose(1, 2)
        similarity = torch.matmul(q0, q1.transpose(2, 3))
        message0 = torch.matmul(similarity.softmax(-1), v1).transpose(1, 2).reshape(1, -1, 256)
        message1 = torch.matmul(similarity.transpose(2, 3).softmax(-1), v0).transpose(1, 2).reshape(1, -1, 256)
        return (desc0 + self.ffn(torch.cat((desc0, self.out(message0)), -1)),
                desc1 + self.ffn(torch.cat((desc1, self.out(message1)), -1)))


class Layer(nn.Module):
    def __init__(self, layer):
        super().__init__()
        self.self_attention = SelfAttention(layer.self_attn)
        self.cross_attention = CrossAttention(layer.cross_attn)

    def forward(self, desc0: Tensor, desc1: Tensor, cos0: Tensor, sin0: Tensor,
                cos1: Tensor, sin1: Tensor) -> tuple[Tensor, Tensor]:
        return self.cross_attention(self.self_attention(desc0, cos0, sin0),
                                    self.self_attention(desc1, cos1, sin1))


class Assignment(nn.Module):
    def __init__(self, assignment, layer):
        super().__init__()
        self.final_proj = assignment.final_proj
        self.matchability = assignment.matchability
        self.register_buffer("layers", torch.tensor([layer], dtype=torch.int64))

    def forward(self, desc0: Tensor, desc1: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        sim = torch.matmul(self.final_proj(desc0) / 4.0, (self.final_proj(desc1) / 4.0).transpose(1, 2))
        scores = (F.log_softmax(sim, 2) + F.log_softmax(sim, 1) +
                  F.logsigmoid(self.matchability(desc0)) + F.logsigmoid(self.matchability(desc1)).transpose(1, 2))
        max0, matches0 = scores.max(2)
        matches1 = scores.argmax(1)
        mutual = torch.arange(matches0.shape[1])[None] == matches1.gather(1, matches0)
        confidence0 = torch.where(mutual, max0.exp(), 0.0)
        return torch.where(mutual & (confidence0 > 0.1), matches0, -1), confidence0, self.layers


class StopConfidence(nn.Module):
    def __init__(self, confidence, threshold):
        super().__init__()
        self.token = confidence.token
        self.threshold = float(threshold)

    def forward(self, desc0: Tensor, desc1: Tensor) -> Tensor:
        confidences = torch.cat((self.token(desc0).squeeze(-1), self.token(desc1).squeeze(-1)), -1)
        confident_fraction = 1.0 - (confidences < self.threshold).float().sum() / confidences.shape[-1]
        return confident_fraction > 0.95


class AdaptiveLightGlue(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.input_proj = model.input_proj
        self.position = model.posenc.Wr
        self.layers = nn.ModuleList([Layer(layer) for layer in model.transformers])
        self.assignments = nn.ModuleList([Assignment(layer, i + 1) for i, layer in enumerate(model.log_assignment)])
        self.stopping = nn.ModuleList([StopConfidence(layer, model.confidence_thresholds[i])
                                      for i, layer in enumerate(model.token_confidence)])

    def encoding(self, points: Tensor) -> tuple[Tensor, Tensor]:
        projected = self.position(points)
        cosine, sine = projected.cos(), projected.sin()
        return (torch.stack((cosine, cosine), -1).reshape(1, 1, -1, 64),
                torch.stack((sine, sine), -1).reshape(1, 1, -1, 64))

    def forward(self, keypoints0: Tensor, keypoints1: Tensor, descriptors0: Tensor,
                descriptors1: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        desc0, desc1 = self.input_proj(descriptors0), self.input_proj(descriptors1)
        cos0, sin0 = self.encoding(keypoints0)
        cos1, sin1 = self.encoding(keypoints1)
        # TorchScript unrolls ModuleList loops but disallows early return inside
        # them. Explicit branches retain the exact upstream per-layer decisions.
        desc0, desc1 = self.layers[0](desc0, desc1, cos0, sin0, cos1, sin1)
        if bool(self.stopping[0](desc0, desc1)):
            return self.assignments[0](desc0, desc1)
        desc0, desc1 = self.layers[1](desc0, desc1, cos0, sin0, cos1, sin1)
        if bool(self.stopping[1](desc0, desc1)):
            return self.assignments[1](desc0, desc1)
        desc0, desc1 = self.layers[2](desc0, desc1, cos0, sin0, cos1, sin1)
        if bool(self.stopping[2](desc0, desc1)):
            return self.assignments[2](desc0, desc1)
        desc0, desc1 = self.layers[3](desc0, desc1, cos0, sin0, cos1, sin1)
        if bool(self.stopping[3](desc0, desc1)):
            return self.assignments[3](desc0, desc1)
        desc0, desc1 = self.layers[4](desc0, desc1, cos0, sin0, cos1, sin1)
        if bool(self.stopping[4](desc0, desc1)):
            return self.assignments[4](desc0, desc1)
        desc0, desc1 = self.layers[5](desc0, desc1, cos0, sin0, cos1, sin1)
        if bool(self.stopping[5](desc0, desc1)):
            return self.assignments[5](desc0, desc1)
        desc0, desc1 = self.layers[6](desc0, desc1, cos0, sin0, cos1, sin1)
        if bool(self.stopping[6](desc0, desc1)):
            return self.assignments[6](desc0, desc1)
        desc0, desc1 = self.layers[7](desc0, desc1, cos0, sin0, cos1, sin1)
        if bool(self.stopping[7](desc0, desc1)):
            return self.assignments[7](desc0, desc1)
        desc0, desc1 = self.layers[8](desc0, desc1, cos0, sin0, cos1, sin1)
        return self.assignments[8](desc0, desc1)
