## Eulerian Graphs

> [!definition] Eulerian Circuit
> An **Eulerian circuit** in a graph $G$ is a closed trail that visits every
> edge exactly once. A graph containing an Eulerian circuit is called an
> **Eulerian graph**.

> [!theorem] Euler's Theorem
> A connected graph $G$ has an Eulerian circuit if and only if every vertex
> has even degree.

> [!proof]
> **($\Rightarrow$)** Suppose $G$ has an Eulerian circuit $C$. Each time $C$
> passes through a vertex $v$ it uses one incoming edge and one outgoing edge,
> contributing 2 to $\deg(v)$. Hence every vertex has even degree.
>
> **($\Leftarrow$)** Suppose every vertex has even degree. By Hierholzer's
> algorithm: start at any vertex $v_0$, walk until returning to $v_0$, then
> splice in sub-circuits from vertices with unused edges until all edges are
> covered. Even degree ensures no dead-ends arise. $\square$

> [!example] $K_4$ has no Eulerian circuit
> Each vertex of $K_4$ has degree 3 (odd), so $K_4$ does **not** contain an
> Eulerian circuit. It does admit an Eulerian path because exactly two vertices
> have odd degree.

The degree-sum formula shows that the total degree is always even:

$$\sum_{v \in V} \deg(v) = 2|E|$$

For the [UNCERTAIN: symbol is unclear here] case where every vertex has degree
exactly 2, the graph is a disjoint union of cycles.

> [!diagram] Example: $K_3$ Eulerian circuit
> ![fig](./assets/<asset-placeholder>.png)
> ```json
> { "type": "undirected",
>   "vertices": ["A", "B", "C"],
>   "edges": [["A", "B"], ["B", "C"], ["A", "C"]],
>   "caption": "Example: $K_3$ Eulerian circuit" }
> ```

<!-- confidence: high -->
